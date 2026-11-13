import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { findClips, selectTopClips, spreadVisualClips, type Candidate, type Word } from "./analyze.js";
import { config, dirs } from "./config.js";
import { db, type ClipRow, type ProjectRow } from "./db.js";
import { run } from "./media.js";
import { enqueue } from "./queue.js";
import { buildSubs, type SubtitleOptions, type TemplateId } from "./subs.js";
import { rankWithOllama } from "./ollama.js";
import { generateHiggsfieldIntro } from "./higgsfield.js";

interface Transcript { language: string; duration: number; words: Word[] }
const transcriptPath = (projectId: string) => path.join(dirs.transcripts, `${projectId}.json`);
const readTranscript = (projectId: string) => JSON.parse(fs.readFileSync(transcriptPath(projectId), "utf8")) as Transcript;

export function removeClips(projectId: string) {
  fs.rmSync(path.join(dirs.exports, projectId), { recursive: true, force: true });
  db.prepare("DELETE FROM clips WHERE project_id=?").run(projectId);
}

export function removeProject(p: ProjectRow) {
  removeClips(p.id);
  fs.rmSync(p.source_path, { force: true });
  fs.rmSync(transcriptPath(p.id), { force: true });
  db.prepare("DELETE FROM projects WHERE id=?").run(p.id);
}

export function queueHiggsfieldIntro(clipId: string) {
  const item = db.prepare("SELECT id,project_id,title FROM clips WHERE id=?").get(clipId) as { id: string; project_id: string; title: string } | undefined;
  if (!item) return;
  const outputPath = path.join(dirs.effects, `${item.id}.mp4`);
  db.prepare("UPDATE clips SET motion_status='generating',motion_request_id=NULL,motion_cancel_url=NULL WHERE id=?").run(item.id);
  enqueue("higgsfield", item.project_id, async (report) => {
    const result = await generateHiggsfieldIntro(item.title, outputPath, report, ({ requestId, cancelUrl }) => {
      db.prepare("UPDATE clips SET motion_request_id=?,motion_cancel_url=? WHERE id=? AND motion_status='generating'")
        .run(requestId, cancelUrl, item.id);
    });
    db.prepare("UPDATE clips SET motion_path=?,motion_status='ready',motion_has_audio=? WHERE id=?")
      .run(outputPath, Number(result.hasAudio), item.id);
  }, (error) => {
    db.prepare("UPDATE clips SET motion_status=CASE WHEN motion_status='canceled' THEN 'canceled' ELSE 'error' END WHERE id=?").run(item.id);
    fs.rmSync(outputPath, { force: true });
    console.error(`Higgsfield falló para el clip ${item.id}: ${error}`);
  }, 0);
}

/** Transcribe una sola vez: si ya existe la transcripción, se reutiliza (caché). */
async function ensureTranscript(p: ProjectRow, report: (n: number, m: string) => void) {
  if (fs.existsSync(transcriptPath(p.id))) {
    report(70, "Usando la transcripción guardada");
    return readTranscript(p.id);
  }
  const tmp = `${transcriptPath(p.id)}.tmp`;
  await run(config.pythonBin, [path.join(config.root, "python", "transcribe.py"), p.source_path, tmp, config.whisperModel], {
    onLine: (l) => {
      const m = /^P ([\d.]+)/.exec(l);
      if (m) report(5 + Number(m[1]) * 65, "Transcribiendo el audio");
    },
  });
  fs.renameSync(tmp, transcriptPath(p.id));
  return readTranscript(p.id);
}

export function queueAnalyze(p: ProjectRow, o: { durations: number[]; count: number; style: string; editMode: string; subtitlesEnabled: boolean }) {
  db.prepare("UPDATE projects SET status='processing' WHERE id=?").run(p.id);
  enqueue(
    "analyze",
    p.id,
    async (report) => {
      report(2, "Preparando");
      let found: Candidate[] = [];
      let hasTranscription = false;
      if (p.has_audio) {
        const tr = await ensureTranscript(p, report);
        if (tr.words.length) {
          report(80, "Buscando los mejores momentos");
          found = findClips(tr.words, o.durations, o.count);
          report(86, `Evaluando ${found.length} finalistas con IA local (si está disponible)`);
          found = selectTopClips(await rankWithOllama(found), o.count);
          hasTranscription = true;
        } else {
          report(80, "Sin voz reconocible; distribuyendo fragmentos visuales");
          found = spreadVisualClips(p.duration_s, o.durations, o.count);
        }
      } else {
        report(80, "El video no tiene audio; distribuyendo fragmentos visuales");
        found = spreadVisualClips(p.duration_s, o.durations, o.count);
      }
      if (!found.length) throw new Error("El vídeo es demasiado corto para esas duraciones");
      removeClips(p.id);
      const ins = db.prepare("INSERT INTO clips (id, project_id, start_s, end_s, score, title, text, reason, score_breakdown, style, edit_mode, subtitles_enabled, distribution, camera_height) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
      for (const c of found) {
        ins.run(randomUUID(), p.id, c.start, c.end, c.score, c.title, c.text, c.reason, JSON.stringify(c.breakdown), o.style,
          o.editMode, Number(o.subtitlesEnabled && hasTranscription), "automatic", 50);
      }
      db.prepare("UPDATE projects SET status='ready', updated_at=datetime('now') WHERE id=?").run(p.id);
    },
    () => db.prepare("UPDATE projects SET status='error' WHERE id=?").run(p.id),
  );
}

interface RoiSegment { x: number; y: number; width: number; height: number; start: number; end: number }

function facecamSegments(c: ClipRow): RoiSegment[] {
  if (c.facecam_mode === "manual") {
    if (!c.facecam_rect) throw new Error("Selecciona el área de la cámara antes de renderizar.");
    const roi = JSON.parse(c.facecam_rect) as { x: number; y: number; width: number; height: number };
    return [{ ...roi, start: 0, end: Number.MAX_SAFE_INTEGER }];
  }
  if (!c.facecam_detection) throw new Error("Detecta la cámara antes de renderizar el modo dividido.");
  const detection = JSON.parse(c.facecam_detection) as {
    selected?: { segments?: RoiSegment[] };
  };
  const segments = detection.selected?.segments;
  if (!segments?.length) throw new Error("No se encontró una cámara. Selecciona manualmente el área de la cámara.");
  return segments;
}

function decimal(value: number) {
  return Number.isFinite(value) ? Number(value.toFixed(3)).toString() : "0";
}

function piecewiseExpression(segments: RoiSegment[], key: "x" | "y", pixels: number, offset: number) {
  const values = segments.map((segment) => ({
    end: Math.max(0, segment.end),
    value: (segment[key] + (key === "x" ? segment.width : segment.height) / 2) * pixels - offset,
  }));
  let expression = decimal(values[values.length - 1].value);
  for (let index = values.length - 2; index >= 0; index--) {
    expression = `if(lt(t,${decimal(values[index].end)}),${decimal(values[index].value)},${expression})`;
  }
  return expression;
}

function splitScreenFilter(c: ClipRow, width: number, height: number, subtitles: boolean, fps: number) {
  const cameraHeightPercent = c.distribution === "automatic" ? 50 : c.camera_height;
  const cameraHeight = Math.max(2, Math.min(1918, Math.round(Math.round(1920 * cameraHeightPercent / 100) / 2) * 2));
  const contentHeight = 1920 - cameraHeight;
  const targetRatio = 1080 / cameraHeight;
  let segments: RoiSegment[];
  try {
    segments = facecamSegments(c);
  } catch {
    // Safe fallback: retain the complete source frame instead of inventing a
    // camera crop when no camera was confidently found.
    return blurredPortraitFilter(subtitles, fps);
  }
  const cameraWidth = Math.max(2, Math.floor(Math.min(
    ...segments.map((segment) => Math.min(segment.width * width, segment.height * height * targetRatio)),
    width,
    height * targetRatio,
  ) / 2) * 2);
  const cameraCropHeight = Math.max(2, Math.floor(Math.min(height, cameraWidth / targetRatio) / 2) * 2);
  const cropX = piecewiseExpression(segments, "x", width, cameraWidth / 2);
  const cropY = piecewiseExpression(segments, "y", height, cameraCropHeight / 2);
  const camera = `[0:v]crop=${cameraWidth}:${cameraCropHeight}:'min(max(${cropX},0),iw-${cameraWidth})':'min(max(${cropY},0),ih-${cameraCropHeight})',scale=1080:${cameraHeight}:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:${cameraHeight},fps=${fps},setsar=1[cam]`;
  const content = `[0:v]scale=1080:${contentHeight}:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:${contentHeight},fps=${fps},setsar=1[content]`;
  const subtitleFilter = subtitles ? ",ass=clip.ass" : "";
  const composition = `[cam][content]vstack=inputs=2,drawbox=y=${cameraHeight - 2}:h=4:color=white@0.35:t=fill${subtitleFilter}[outv]`;
  return ["-filter_complex", `${content};${camera};${composition}`, "-map", "[outv]", "-map", "0:a:0?"];
}

function blurredPortraitFilter(subtitles: boolean, fps: number) {
  const subtitleFilter = subtitles ? ",ass=clip.ass" : "";
  return [
    "-filter_complex",
    `[0:v]split=2[bgsrc][fgsrc];[bgsrc]scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,gblur=sigma=28[bg];[fgsrc]scale=1080:1920:force_original_aspect_ratio=decrease:flags=lanczos[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2${subtitleFilter},fps=${fps},setsar=1[outv]`,
    "-map", "[outv]", "-map", "0:a:0?",
  ];
}

function fullFrameVerticalFilter(subtitles: boolean, fps: number) {
  const subtitleFilter = subtitles ? ",ass=clip.ass" : "";
  return [
    "-filter_complex",
    `[0:v]scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920:(iw-1080)/2:(ih-1920)/2${subtitleFilter},fps=${fps},setsar=1[outv]`,
    "-map", "[outv]", "-map", "0:a:0?",
  ];
}

function faceTrackingFilter(c: ClipRow, width: number, height: number, subtitles: boolean, fps: number) {
  const parsed = c.facecam_detection ? JSON.parse(c.facecam_detection) as { selected?: { segments?: RoiSegment[] } } : null;
  const segments = parsed?.selected?.segments;
  if (!segments?.length || width < 2 || height < 2) return fullFrameVerticalFilter(subtitles, fps);
  const zoom = 1.12;
  const cropWidth = Math.max(2, Math.floor(Math.min(width, height * 9 / 16) / zoom / 2) * 2);
  const cropHeight = Math.max(2, Math.floor(Math.min(height, width * 16 / 9) / zoom / 2) * 2);
  const pointAt = (segment: RoiSegment, axis: "x" | "y") => {
    if (axis === "x") return (segment.x + segment.width / 2) * width - cropWidth / 2;
    const faceY = segment.y + segment.height * 0.42;
    return faceY * height - cropHeight * 0.37;
  };
  const trackingExpression = (axis: "x" | "y") => {
    const points = segments.map((segment) => ({ time: (segment.start + segment.end) / 2, value: pointAt(segment, axis) }));
    let expression = String(Number(points.at(-1)!.value.toFixed(2)));
    for (let index = points.length - 2; index >= 0; index--) {
      const from = points[index];
      const to = points[index + 1];
      const span = Math.max(0.05, to.time - from.time);
      expression = `if(lt(t,${to.time.toFixed(3)}),${from.value.toFixed(2)}+(${to.value.toFixed(2)}-${from.value.toFixed(2)})*max(0,min(1,(t-${from.time.toFixed(3)})/${span.toFixed(3)})),${expression})`;
    }
    return expression;
  };
  const x = trackingExpression("x");
  const y = trackingExpression("y");
  const subtitleFilter = subtitles ? ",ass=clip.ass" : "";
  return [
    "-filter_complex",
    `[0:v]crop=${cropWidth}:${cropHeight}:'min(max(${x},0),iw-${cropWidth})':'min(max(${y},0),ih-${cropHeight})',scale=1080:1920:flags=lanczos${subtitleFilter},fps=${fps},setsar=1[outv]`,
    "-map", "[outv]", "-map", "0:a:0?",
  ];
}

export function queueRender(clipId: string) {
  const c = db
    .prepare("SELECT c.*, p.source_path, p.duration_s, p.layout, p.width, p.height, p.fps, p.has_audio AS source_has_audio FROM clips c JOIN projects p ON p.id=c.project_id WHERE c.id=?")
    .get(clipId) as (ClipRow & { source_path: string; duration_s: number; layout: string; width: number; height: number; fps: number; source_has_audio: number }) | undefined;
  if (!c) return;
  db.prepare("UPDATE clips SET status='rendering' WHERE id=?").run(clipId);
  enqueue(
    "render",
    c.project_id,
    async (report) => {
      const work = path.join(dirs.work, c.id);
      const outDir = path.join(dirs.exports, c.project_id);
      fs.mkdirSync(work, { recursive: true });
      fs.mkdirSync(outDir, { recursive: true });
      try {
        const start = Math.max(0, c.start_s - 0.2);
        const end = Math.min(c.duration_s || c.end_s + 0.3, c.end_s + 0.3);
        const fps = Number(Math.min(60, Math.max(1, c.fps || 30)).toFixed(3));
        const includeIntro = c.motion_status === "ready" && !!c.motion_path && fs.existsSync(c.motion_path);
        const introDuration = includeIntro ? 1.35 : 0;
        const outputDuration = end - start + introDuration;
        const subtitles = c.subtitles_enabled === 1;
        const subs = subtitles
          ? buildSubs(
              readTranscript(c.project_id).words,
              start,
              end,
              c.style as TemplateId,
              {
                font: c.subtitle_font,
                size: c.subtitle_size,
                color: c.subtitle_color,
                position: c.subtitle_position as SubtitleOptions["position"],
              },
            )
          : null;
        if (subs) fs.writeFileSync(path.join(work, "clip.ass"), subs.ass, "utf8");
        const out = path.join(outDir, `${c.id}.mp4`);
        report(10, "Renderizando el clip");
        let layoutArgs: string[];
        if (c.edit_mode === "ibai") {
          layoutArgs = fullFrameVerticalFilter(subtitles, fps);
        } else if (c.edit_mode === "face-tracking") {
          layoutArgs = faceTrackingFilter(c, c.width || 1080, c.height || 1920, subtitles, fps);
        } else if (c.edit_mode === "split-screen") {
          layoutArgs = splitScreenFilter(c, c.width || 1080, c.height || 1920, subtitles, fps);
        } else if (c.layout === "reaction-left" || c.layout === "reaction-right") {
          const reactionLeft = c.layout === "reaction-left";
          const gameplayCrop = reactionLeft
            ? "crop=trunc(iw/2/2)*2:ih:trunc(iw/2/2)*2:0"
            : "crop=trunc(iw/2/2)*2:ih:0:0";
          const reactionCrop = reactionLeft
            ? "crop=trunc(iw/2/2)*2:ih:0:0"
            : "crop=trunc(iw/2/2)*2:ih:trunc(iw/2/2)*2:0";
          const subtitleFilter = subtitles ? ",ass=clip.ass" : "";
          layoutArgs = [
            "-filter_complex",
            `[0:v]${gameplayCrop},scale=1080:960:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:960,fps=${fps}[gp];[0:v]${reactionCrop},scale=1080:960:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:960,fps=${fps}[cam];[cam][gp]vstack=inputs=2${subtitleFilter}[outv]`,
            "-map", "[outv]", "-map", "0:a:0?",
          ];
        } else {
          // Conventional landscape clips stay fully visible in a vertical
          // frame, with a blurred enlarged copy filling the top and bottom.
          layoutArgs = blurredPortraitFilter(subtitles, fps);
        }
        if (includeIntro && c.motion_path) {
          const graphIndex = layoutArgs.indexOf("-filter_complex");
          const graph = layoutArgs[graphIndex + 1].replace(/\[outv\]/g, "[mainv]");
          const introAudio = c.motion_has_audio
            ? `[1:a:0]atrim=duration=${introDuration},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=0.42[introa]`
            : `anullsrc=sample_rate=48000:channel_layout=stereo,atrim=duration=${introDuration},asetpts=PTS-STARTPTS[introa]`;
          const mainAudio = c.source_has_audio
            ? `[0:a:0]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo[maina]`
            : `anullsrc=sample_rate=48000:channel_layout=stereo,atrim=duration=${end - start},asetpts=PTS-STARTPTS[maina]`;
          const introGraph = [
            `[1:v:0]trim=duration=${introDuration},setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,fps=${fps},setsar=1[introv]`,
            `[introv][mainv]concat=n=2:v=1:a=0[outv]`,
            introAudio,
            mainAudio,
            `[introa][maina]concat=n=2:v=0:a=1[outa]`,
          ].join(";");
          layoutArgs.splice(graphIndex, layoutArgs.length - graphIndex,
            "-filter_complex", `${graph};${introGraph}`, "-map", "[outv]", "-map", "[outa]");
        }
        await run(config.ffmpegBin, [
          "-progress", "pipe:1", "-nostats", "-y", "-hide_banner", "-loglevel", "error",
          "-ss", start.toFixed(2), "-t", (end - start).toFixed(2), "-i", c.source_path,
          ...(includeIntro && c.motion_path ? ["-i", c.motion_path] : []),
          ...layoutArgs,
          "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
          "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-profile:v", "high", "-pix_fmt", "yuv420p",
          "-c:a", "aac", "-b:a", "320k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", out,
        ], {
          cwd: work,
          onLine: (line) => {
            const match = /^out_time_(?:us|ms)=(\d+)/.exec(line);
            if (!match) return;
            const elapsed = Number(match[1]) / 1_000_000;
            const duration = Math.max(1, outputDuration);
            const progress = Math.min(98, 10 + Math.round((elapsed / duration) * 88));
            report(progress, `Renderizando el clip · ${progress}%`);
          },
        });
        const srtPath = path.join(outDir, `${c.id}.srt`);
        if (subs) fs.writeFileSync(srtPath, subs.srt, "utf8");
        else fs.rmSync(srtPath, { force: true });
        db.prepare("UPDATE clips SET status='done', output_path=? WHERE id=?").run(out, c.id);
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }
    },
    () => db.prepare("UPDATE clips SET status='error' WHERE id=?").run(c.id),
  );
}
