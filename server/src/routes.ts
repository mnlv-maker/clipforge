import fs from "node:fs";
import path from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { Router } from "express";

const require = createRequire(import.meta.url);
const archiver = require("archiver") as typeof import("archiver");
import multer from "multer";
import { config, dirs } from "./config.js";
import { db, type ClipRow, type ProjectRow } from "./db.js";
import { probe } from "./media.js";
import { queueAnalyze, queueRender, queueHiggsfieldIntro, removeProject } from "./pipeline.js";
import { cancelHiggsfieldRequest } from "./higgsfield.js";
import { TEMPLATES } from "./subs.js";

const execFileAsync = promisify(execFile);
const r = Router();
const EXT = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"]);
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);
const KICK_HOSTS = new Set(["kick.com", "www.kick.com", "m.kick.com"]);
const LAYOUTS = new Set(["center", "reaction-left", "reaction-right"]);
const EDIT_MODES = new Set(["traditional", "split-screen", "ibai", "face-tracking"]);
const DISTRIBUTIONS = new Set(["automatic", "custom"]);
const SUBTITLE_FONTS = new Set(["Arial", "Impact", "Verdana", "Georgia", "Trebuchet MS"]);
const SUBTITLE_POSITIONS = new Set(["top", "middle", "bottom"]);
const isTemplate = (value: string): value is keyof typeof TEMPLATES => Object.hasOwn(TEMPLATES, value);
const upload = multer({
  storage: multer.diskStorage({
    destination: dirs.uploads,
    filename: (_q, f, cb) => cb(null, `${randomUUID()}${path.extname(f.originalname).toLowerCase()}`),
  }),
  fileFilter: (_q, f, cb) => cb(null, EXT.has(path.extname(f.originalname).toLowerCase())),
  limits: { fileSize: 8 * 1024 ** 3 },
});

const project = (id: string) => db.prepare("SELECT * FROM projects WHERE id=?").get(id) as ProjectRow | undefined;
const clip = (id: string) => db.prepare("SELECT * FROM clips WHERE id=?").get(id) as ClipRow | undefined;
const slug = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 40) || "clip";
const NOT_FOUND = { error: "No encontrado" };

interface YoutubeInfo { id: string; title?: string; live_status?: string; is_live?: boolean; formats?: { acodec?: string }[] }
interface Capture {
  projectId: string;
  startedAt: number;
  stopFile: string;
  child: ChildProcess;
  stderr: string;
  stopping: boolean;
  finished: boolean;
  done: Promise<void>;
  finish: () => void;
}

const captures = new Map<string, Capture>();

function saveHiggsfieldKey(key: string | null) {
  const envPath = path.join(config.root, ".env");
  const oldContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const lines = oldContent.split(/\r?\n/).filter((line) => !/^\s*(?:HF_API_KEY|HF_CREDENTIALS|HF_KEY)\s*=/.test(line));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (key) lines.push(`HF_API_KEY=${JSON.stringify(key)}`);
  fs.writeFileSync(envPath, lines.length ? `${lines.join("\n")}\n` : "", { encoding: "utf8", mode: 0o600 });
  delete process.env.HF_CREDENTIALS;
  delete process.env.HF_KEY;
  if (key) process.env.HF_API_KEY = key;
  else delete process.env.HF_API_KEY;
  config.higgsfieldCredentials = key ?? "";
}

function youtubeUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("Pega un enlace de YouTube o Kick válido.");
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("Pega un enlace de YouTube o Kick válido."); }
  if (url.protocol !== "https:" || (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase()) && !KICK_HOSTS.has(url.hostname.toLowerCase())) || url.username || url.password) {
    throw new Error("Solo se aceptan enlaces HTTPS de YouTube o Kick.");
  }
  return url.toString();
}

function youtubeError(error: unknown): string {
  const message = typeof error === "object" && error && "stderr" in error && typeof error.stderr === "string"
    ? error.stderr.trim()
    : error instanceof Error ? error.message : String(error);
  if (/sign in to confirm your age|age-restricted|confirm your age/i.test(message)) {
    return "YouTube exige iniciar sesión para este video. Exporta tus cookies de YouTube en formato Netscape, configura YTDLP_COOKIES_FILE en .env y reinicia el servidor. Mantén ese archivo privado y no lo compartas.";
  }
  return message;
}

async function getYoutubeInfo(url: string): Promise<YoutubeInfo> {
  const { stdout } = await execFileAsync(config.pythonBin, [
    path.join(config.root, "python", "youtube_pytubefix.py"), "info", url,
  ], { timeout: 60000, maxBuffer: 10 * 1024 * 1024, windowsHide: true });
  return JSON.parse(stdout) as YoutubeInfo;
}

function downloadedFile(id: string): string | undefined {
  const files = fs.readdirSync(dirs.uploads)
    .filter((name) => name.startsWith(`${id}.`) && !name.endsWith(".part") && !name.endsWith(".ytdl"))
    .map((name) => path.join(dirs.uploads, name))
    .filter((file) => fs.statSync(file).isFile());
  return files.find((file) => path.extname(file).toLowerCase() === ".mp4") ?? files[0];
}

function removeDownloadFiles(id: string) {
  for (const name of fs.readdirSync(dirs.uploads).filter((entry) => entry.startsWith(`${id}.`))) {
    fs.rmSync(path.join(dirs.uploads, name), { force: true });
  }
}

function downloadYoutube(url: string, id: string): Promise<string> {
  const outputTemplate = path.join(dirs.uploads, `${id}.%(ext)s`);
  return execFileAsync(config.pythonBin, [
    path.join(config.root, "python", "youtube_pytubefix.py"), "download", url, outputTemplate,
  ], { maxBuffer: 10 * 1024 * 1024, windowsHide: true })
    .then(() => {
      const file = downloadedFile(id);
      if (!file) throw new Error("yt-dlp terminó, pero no se encontró el vídeo descargado.");
      return file;
    })
    .catch((error) => {
      removeDownloadFiles(id);
      throw error;
    });
}

async function finishCapture(capture: Capture, code: number | null, signal: NodeJS.Signals | null, failure?: Error) {
  if (capture.finished) return;
  capture.finished = true;
  try {
    if (failure) throw failure;
    if (code !== 0 && !capture.stopping) {
      throw new Error(capture.stderr.trim() || `La captura terminó inesperadamente (${signal ?? `código ${code}`}).`);
    }
    const file = downloadedFile(capture.projectId);
    if (!file) throw new Error(capture.stderr.trim() || "No se pudo finalizar el archivo de la transmisión.");
    const media = await probe(file);
    if (!media.hasAudio) throw new Error("La transmisión capturada no contiene audio.");
    db.prepare("UPDATE projects SET source_path=?,duration_s=?,width=?,height=?,fps=?,has_audio=1,status='created',error=NULL,updated_at=datetime('now') WHERE id=?")
      .run(file, media.duration, media.width, media.height, media.fps, capture.projectId);
  } catch (e) {
    const message = youtubeError(e);
    db.prepare("UPDATE projects SET status='error',has_audio=0,error=?,updated_at=datetime('now') WHERE id=?").run(message, capture.projectId);
    removeDownloadFiles(capture.projectId);
  } finally {
    captures.delete(capture.projectId);
    try {
      fs.rmSync(capture.stopFile, { force: true });
    } catch (e) {
      console.error(`No se pudo limpiar el marcador de captura ${capture.stopFile}:`, e);
    } finally {
      capture.finish();
    }
  }
}

function startLiveCapture(projectId: string, url: string) {
  const stopFile = path.join(dirs.work, `${projectId}.stop`);
  const args = [
    path.join(config.root, "python", "capture_youtube.py"),
    url,
    path.join(dirs.uploads, `${projectId}.%(ext)s`),
    stopFile,
  ];
  const child = spawn(config.pythonBin, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const capture: Capture = { projectId, startedAt: Date.now(), stopFile, child, stderr: "", stopping: false, finished: false, done, finish };
  captures.set(projectId, capture);
  child.stderr?.on("data", (chunk: Buffer) => { capture.stderr = (capture.stderr + chunk.toString()).slice(-3000); });
  child.once("error", (e) => { void finishCapture(capture, null, null, e); });
  child.once("close", (code, signal) => { void finishCapture(capture, code, signal); });
}

async function waitForCapture(capture: Capture, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void capture.done.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function stopLiveCapture(capture: Capture) {
  if (!capture.stopping) {
    fs.writeFileSync(capture.stopFile, "stop");
    capture.stopping = true;
    db.prepare("UPDATE projects SET status='stopping',updated_at=datetime('now') WHERE id=?").run(capture.projectId);
  }
  if (await waitForCapture(capture, 60000)) return;
  if (capture.child.exitCode === null && capture.child.signalCode === null) capture.child.kill("SIGTERM");
  if (await waitForCapture(capture, 5000)) return;
  if (capture.child.exitCode === null && capture.child.signalCode === null) capture.child.kill("SIGKILL");
  await capture.done;
}

r.get("/templates", (_q, res) => {
  res.json(Object.entries(TEMPLATES).map(([id, t]) => ({ id, label: t.label })));
});

r.get("/projects", (_q, res) => {
  res.json(db.prepare("SELECT p.*, (SELECT COUNT(*) FROM clips c WHERE c.project_id=p.id) AS clip_count FROM projects p ORDER BY created_at DESC, rowid DESC").all());
});

r.post("/projects", upload.single("video"), async (req, res) => {
  const f = req.file;
  if (!f) return void res.status(400).json({ error: "Formato no válido. Usa MP4, MOV, MKV, WEBM, AVI o M4V." });
  try {
    const m = await probe(f.path);
    const id = randomUUID();
    const given = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const name = given || Buffer.from(f.originalname, "latin1").toString("utf8").replace(/\.[^.]+$/, "");
    const subtitlesEnabled = req.body?.subtitlesEnabled !== "false";
    db.prepare("INSERT INTO projects (id,name,source_path,duration_s,width,height,fps,has_audio,subtitles_enabled) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, name, f.path, m.duration, m.width, m.height, m.fps, m.hasAudio ? 1 : 0, Number(subtitlesEnabled));
    res.status(201).json(project(id));
  } catch (e) {
    fs.rmSync(f.path, { force: true });
    res.status(400).json({ error: `No se pudo leer el vídeo: ${e instanceof Error ? e.message : String(e)}` });
  }
});

r.post("/projects/youtube", async (req, res) => {
  const body = (req.body ?? {}) as { url?: unknown; mode?: unknown; name?: unknown; authorized?: unknown; subtitlesEnabled?: unknown };
  if (body.authorized !== true) return void res.status(400).json({ error: "Confirma que tienes permiso para usar y descargar este contenido." });
  if (body.mode !== "video" && body.mode !== "live") return void res.status(400).json({ error: "Elige si el enlace es un video o una transmisión en vivo." });
  let url: string;
  try {
    url = youtubeUrl(body.url);
  } catch (e) {
    return void res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }

  const id = randomUUID();
  const subtitlesEnabled = body.subtitlesEnabled !== false;
  const requestedName = typeof body.name === "string" ? body.name.trim() : "";
  if (body.mode === "live") {
    const name = requestedName || "Transmisión de YouTube";
    const source = path.join(dirs.uploads, `${id}.mp4`);
    db.prepare("INSERT INTO projects (id,name,source_path,source_url,duration_s,width,height,has_audio,subtitles_enabled,status) VALUES (?,?,?,?,0,0,0,1,?,'recording')")
      .run(id, name, source, url, Number(subtitlesEnabled));
    startLiveCapture(id, url);
    return void res.status(201).json(project(id));
  }

  try {
    const info = await getYoutubeInfo(url);
    const isLive = info.is_live === true || info.live_status === "is_live";
    if (isLive || info.live_status === "is_upcoming") {
      return void res.status(400).json({ error: "Este enlace es un live activo o programado. Elige la opción de transmisión en vivo cuando haya comenzado." });
    }
    const name = requestedName || info.title?.trim() || `YouTube ${info.id}`;
    const file = await downloadYoutube(url, id);
    const media = await probe(file);
    db.prepare("INSERT INTO projects (id,name,source_path,source_url,duration_s,width,height,fps,has_audio,subtitles_enabled) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, name, file, url, media.duration, media.width, media.height, media.fps, Number(media.hasAudio), Number(subtitlesEnabled && media.hasAudio));
    return void res.status(201).json(project(id));
  } catch (e) {
    console.error("Error importando video de YouTube:", e);
    removeDownloadFiles(id);
    return void res.status(400).json({ error: `No se pudo obtener el contenido: ${youtubeError(e)}` });
  }
});

r.get("/projects/:id", (req, res) => {
  const p = project(req.params.id);
  if (!p) return void res.status(404).json(NOT_FOUND);
  const activeJobs = db.prepare("SELECT type,status,progress,message,error FROM jobs WHERE project_id=? AND status IN ('queued','running') ORDER BY created_at DESC, rowid DESC").all(p.id) as { type: string; status: string; progress: number; message: string | null; error: string | null }[];
  const latestJob = db.prepare("SELECT type,status,progress,message,error FROM jobs WHERE project_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(p.id) as { type: string; status: string; progress: number; message: string | null; error: string | null } | undefined;
  res.json({
    project: p,
    clips: db.prepare("SELECT id,project_id,start_s,end_s,score,title,text,reason,score_breakdown,style,edit_mode,subtitles_enabled,distribution,camera_height,facecam_mode,facecam_rect,facecam_detection,facecam_status,motion_status,motion_has_audio,subtitle_font,subtitle_size,subtitle_color,subtitle_position,status FROM clips WHERE project_id=? ORDER BY start_s").all(p.id),
    job: activeJobs.length ? {
      ...activeJobs[0],
      progress: Math.round(activeJobs.reduce((total, item) => total + Number(item.progress || 0), 0) / activeJobs.length),
      activeCount: activeJobs.length,
    } : latestJob ?? null,
    capture: captures.has(p.id) ? {
      startedAt: captures.get(p.id)!.startedAt,
      elapsedSeconds: Math.max(0, Math.floor((Date.now() - captures.get(p.id)!.startedAt) / 1000)),
      bytes: fs.readdirSync(dirs.uploads)
        .filter((entry) => entry.startsWith(`${p.id}.`))
        .reduce((total, entry) => {
          try { return total + fs.statSync(path.join(dirs.uploads, entry)).size; } catch { return total; }
        }, 0),
    } : null,
  });
});

r.get("/projects/:id/source", (req, res) => {
  const p = project(req.params.id);
  if (!p) return void res.status(404).json(NOT_FOUND);
  if (p.status === "recording" || p.status === "stopping" || !fs.existsSync(p.source_path)) {
    return void res.status(409).json({ error: "El video original aún no está disponible." });
  }
  res.set("Cache-Control", "no-store");
  res.sendFile(p.source_path, { cacheControl: false });
});

r.delete("/projects/:id", (req, res) => {
  const p = project(req.params.id);
  if (!p) return void res.status(404).json(NOT_FOUND);
  if (p.status === "recording" || p.status === "stopping") return void res.status(409).json({ error: "Detén la captura en vivo antes de borrar el proyecto." });
  removeProject(p);
  res.json({ ok: true });
});

r.post("/projects/:id/stop-capture", async (req, res) => {
  const p = project(req.params.id);
  if (!p) return void res.status(404).json(NOT_FOUND);
  const capture = captures.get(p.id);
  if (!capture) return void res.status(409).json({ error: "No hay una captura activa que se pueda detener." });
  try {
    await stopLiveCapture(capture);
    const updated = project(p.id);
    if (updated?.status === "error") return void res.status(500).json({ error: updated.error ?? "No se pudo finalizar la captura." });
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

r.patch("/projects/:id/layout", (req, res) => {
  const p = project(req.params.id);
  if (!p) return void res.status(404).json(NOT_FOUND);
  const layout = (req.body as { layout?: unknown } | undefined)?.layout;
  if (typeof layout !== "string" || !LAYOUTS.has(layout)) {
    return void res.status(400).json({ error: "Elige una composición de video válida." });
  }
  db.prepare("UPDATE projects SET layout=? WHERE id=?").run(layout, p.id);
  res.json(project(p.id));
});

r.post("/projects/:id/analyze", (req, res) => {
  const p = project(req.params.id);
  if (!p) return void res.status(404).json(NOT_FOUND);
  if (p.status === "processing") return void res.status(409).json({ error: "Este proyecto ya se está procesando" });
  if (p.status === "recording" || p.status === "stopping") return void res.status(409).json({ error: "Detén la captura en vivo antes de analizar el proyecto." });
  const b = (req.body ?? {}) as { durations?: unknown; count?: unknown; style?: unknown; layout?: unknown; editMode?: unknown; subtitlesEnabled?: unknown };
  const durations = (Array.isArray(b.durations) ? b.durations : [30]).map(Number).filter((n) => n >= 5 && n <= 300);
  if (!durations.length) return void res.status(400).json({ error: "Elige al menos una duración (entre 5 y 300 segundos)" });
  const count = Math.min(20, Math.max(1, Number(b.count) || 5));
  let style = typeof b.style === "string" && isTemplate(b.style) ? b.style : "mrbeast";
  let layout = typeof b.layout === "string" && LAYOUTS.has(b.layout) ? b.layout : "center";
  const editMode = typeof b.editMode === "string" && EDIT_MODES.has(b.editMode) ? b.editMode : "traditional";
  if (editMode === "ibai") {
    style = "ibai";
    layout = "center";
  }
  db.prepare("UPDATE projects SET layout=? WHERE id=?").run(layout, p.id);
  if (typeof b.subtitlesEnabled === "boolean") {
    db.prepare("UPDATE projects SET subtitles_enabled=? WHERE id=?").run(Number(b.subtitlesEnabled), p.id);
  }
  queueAnalyze(p, {
    durations,
    count,
    style,
    editMode,
    subtitlesEnabled: typeof b.subtitlesEnabled === "boolean" ? b.subtitlesEnabled : p.subtitles_enabled !== 0,
  });
  res.status(202).json({ ok: true });
});

r.patch("/clips/:id/settings", (req, res) => {
  const c = clip(req.params.id);
  if (!c) return void res.status(404).json(NOT_FOUND);
  if (c.status === "rendering") return void res.status(409).json({ error: "No se puede cambiar la configuración mientras se renderiza." });
  const body = (req.body ?? {}) as Record<string, unknown>;
  const updates: [string, string | number | null][] = [];
  const add = (input: string, column: string, validate: (value: unknown) => string | number | null | undefined) => {
    if (!(input in body)) return;
    const value = validate(body[input]);
    if (value === undefined) throw new Error(`El valor de ${input} no es válido.`);
    updates.push([column, value]);
  };
  try {
    add("editMode", "edit_mode", (value) => typeof value === "string" && EDIT_MODES.has(value) ? value : undefined);
    add("subtitlesEnabled", "subtitles_enabled", (value) => typeof value === "boolean" ? Number(value) : undefined);
    add("distribution", "distribution", (value) => typeof value === "string" && DISTRIBUTIONS.has(value) ? value : undefined);
    add("cameraHeight", "camera_height", (value) => Number.isInteger(value) && Number(value) >= 30 && Number(value) <= 70 ? Number(value) : undefined);
    add("facecamMode", "facecam_mode", (value) => value === "automatic" || value === "manual" ? value : undefined);
    add("facecamRect", "facecam_rect", (value) => {
      if (value === null) return null;
      if (!value || typeof value !== "object") return undefined;
      const rect = value as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
      if (![rect.x, rect.y, rect.width, rect.height].every((n) => typeof n === "number" && Number.isFinite(n))) return undefined;
      const { x, y, width, height } = rect as { x: number; y: number; width: number; height: number };
      if (x < 0 || y < 0 || width < 0.02 || height < 0.02 || x + width > 1 || y + height > 1) return undefined;
      return JSON.stringify({ x, y, width, height });
    });
    add("style", "style", (value) => typeof value === "string" && isTemplate(value) ? value : undefined);
    add("subtitleFont", "subtitle_font", (value) => typeof value === "string" && SUBTITLE_FONTS.has(value) ? value : undefined);
    add("subtitleSize", "subtitle_size", (value) => Number.isInteger(value) && Number(value) >= 24 && Number(value) <= 160 ? Number(value) : undefined);
    add("subtitleColor", "subtitle_color", (value) => typeof value === "string" && /^[0-9A-Fa-f]{6}$/.test(value) ? value.toUpperCase() : undefined);
    add("subtitlePosition", "subtitle_position", (value) => typeof value === "string" && SUBTITLE_POSITIONS.has(value) ? value : undefined);
    if (body.editMode === "ibai") {
      const force = (column: string, value: string | number) => {
        const index = updates.findIndex(([name]) => name === column);
        if (index < 0) updates.push([column, value]);
        else updates[index] = [column, value];
      };
      force("style", "ibai");
      force("subtitles_enabled", 1);
      force("distribution", "automatic");
    }
    if (updates.length) {
      const assignments = updates.map(([column]) => `${column}=?`).join(", ");
      // Keep the current render available while the user edits settings; the
      // next explicit render applies them and replaces the cached output.
      db.prepare(`UPDATE clips SET ${assignments} WHERE id=?`)
        .run(...updates.map(([, value]) => value), c.id);
    }
    res.json(clip(c.id));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

r.post("/clips/:id/detect-facecam", async (req, res) => {
  const c = clip(req.params.id);
  if (!c) return void res.status(404).json(NOT_FOUND);
  if (c.status === "rendering") return void res.status(409).json({ error: "Espera a que termine el render." });
  const p = project(c.project_id);
  if (!p || !fs.existsSync(p.source_path)) return void res.status(404).json({ error: "No se encontró el video original." });
  const sourceStart = Math.max(0, c.start_s - 0.2);
  const sourceEnd = Math.min(p.duration_s || c.end_s + 0.3, c.end_s + 0.3);
  const modelPath = path.join(dirs.models, "blaze_face_short_range.tflite");
  fs.mkdirSync(dirs.models, { recursive: true });
  db.prepare("UPDATE clips SET facecam_status='detecting' WHERE id=?").run(c.id);
  try {
    const { stdout } = await execFileAsync(config.pythonBin, [
      path.join(config.root, "python", "detect_facecam.py"),
      p.source_path,
      sourceStart.toFixed(3),
      sourceEnd.toFixed(3),
      modelPath,
      String(c.distribution === "automatic" ? 50 : c.camera_height),
    ], { timeout: 180000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
    const result = JSON.parse(stdout) as { found: boolean };
    db.prepare("UPDATE clips SET facecam_detection=?,facecam_status=? WHERE id=?")
      .run(JSON.stringify(result), result.found ? "ready" : "not-found", c.id);
    res.json({ ...result, status: result.found ? "ready" : "not-found" });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    db.prepare("UPDATE clips SET facecam_status='error' WHERE id=?").run(c.id);
    res.status(500).json({ error: `No se pudo detectar la cámara: ${message}` });
  }
});

r.post("/clips/:id/render", (req, res) => {
  const c = clip(req.params.id);
  if (!c) return void res.status(404).json(NOT_FOUND);
  if (c.status === "rendering") return void res.status(409).json({ error: "Este clip ya se está renderizando" });
  if (c.motion_status === "generating") return void res.status(409).json({ error: "Espera a que Higgsfield termine de generar el motion graphic." });
  const style = (req.body as { style?: unknown } | undefined)?.style;
  if (typeof style === "string" && isTemplate(style)) db.prepare("UPDATE clips SET style=? WHERE id=?").run(style, c.id);
  queueRender(c.id);
  res.status(202).json({ ok: true });
});

r.post("/clips/:id/higgsfield-intro", (req, res) => {
  if (!config.higgsfieldCredentials) return void res.status(503).json({ error: "Conecta tu API key de Higgsfield desde Configuración." });
  const c = clip(req.params.id);
  if (!c) return void res.status(404).json(NOT_FOUND);
  if (c.status === "rendering" || c.motion_status === "generating") return void res.status(409).json({ error: "Este clip ya tiene un proceso en curso." });
  queueHiggsfieldIntro(c.id);
  res.status(202).json({ ok: true, message: "Generación enviada a Higgsfield." });
});

r.post("/clips/:id/higgsfield-intro/cancel", async (req, res) => {
  const c = clip(req.params.id);
  if (!c) return void res.status(404).json(NOT_FOUND);
  if (c.motion_status !== "generating") return void res.status(409).json({ error: "Este clip no tiene una generación activa." });
  if (!c.motion_cancel_url || !c.motion_request_id) return void res.status(409).json({ error: "Higgsfield aún no ha aceptado la solicitud; espera un momento antes de cancelar." });
  try {
    const response = await cancelHiggsfieldRequest(c.motion_cancel_url);
    if (response.status === "completed") return void res.status(409).json({ error: "La generación ya terminó y no se puede cancelar." });
    db.prepare("UPDATE clips SET motion_status='canceled',motion_cancel_url=NULL WHERE id=? AND motion_status='generating'").run(c.id);
    res.json({ ok: true, status: "canceled" });
  } catch (e) {
    const message = e instanceof Error ? e.message : "No se pudo cancelar la solicitud.";
    res.status(502).json({ error: message });
  }
});

r.post("/projects/:id/render-all", (req, res) => {
  const rows = db.prepare("SELECT id FROM clips WHERE project_id=? AND status IN ('pending','error') ORDER BY start_s").all(req.params.id) as { id: string }[];
  rows.forEach((c) => queueRender(c.id));
  res.status(202).json({ queued: rows.length });
});

const outputOf = (id: string, ext: "mp4" | "srt") => {
  const c = clip(id);
  if (ext === "srt" && c?.subtitles_enabled !== 1) return null;
  const file = c?.output_path?.replace(/\.mp4$/, `.${ext}`);
  return c && file && fs.existsSync(file) ? { c, file } : null;
};

r.get("/settings/higgsfield-key", (_req, res) => {
  res.json({ configured: Boolean(config.higgsfieldCredentials) });
});

r.put("/settings/higgsfield-key", (req, res) => {
  const key = (req.body as { key?: unknown } | undefined)?.key;
  if (typeof key !== "string" || !key.length || key.length > 1024 || key.trim() !== key || /[\r\n\0]/.test(key)) {
    return void res.status(400).json({ error: "Pega la clave completa de Higgsfield, sin espacios antes o después." });
  }
  try {
    saveHiggsfieldKey(key);
    res.json({ configured: true, saved: true, validityVerified: false });
  } catch {
    res.status(500).json({ error: "No se pudo guardar la clave en la configuración local." });
  }
});

r.delete("/settings/higgsfield-key", (_req, res) => {
  try {
    saveHiggsfieldKey(null);
    res.json({ configured: false });
  } catch {
    res.status(500).json({ error: "No se pudo quitar la clave de la configuración local." });
  }
});

r.get("/clips/:id/video", (req, res) => {
  const o = outputOf(req.params.id, "mp4");
  if (!o) return void res.status(404).json({ error: "El clip aún no está renderizado" });
  res.set("Cache-Control", "no-cache");
  res.sendFile(o.file, { cacheControl: false });
});

for (const ext of ["mp4", "srt"] as const) {
  r.get(`/clips/:id/${ext}`, (req, res) => {
    const o = outputOf(req.params.id, ext);
    if (!o) return void res.status(404).json({ error: "El archivo aún no existe" });
    res.download(o.file, `${slug(o.c.title)}.${ext}`);
  });
}

r.get("/projects/:id/zip", (req, res) => {
  const p = project(req.params.id);
  if (!p) return void res.status(404).json(NOT_FOUND);
  const done = db.prepare("SELECT * FROM clips WHERE project_id=? AND status='done' ORDER BY start_s").all(p.id) as ClipRow[];
  if (!done.length) return void res.status(400).json({ error: "Aún no hay clips renderizados" });
  res.attachment(`${slug(p.name)}-clips.zip`);
  const z = archiver("zip", { zlib: { level: 0 } });
  z.on("error", (e: Error) => res.destroy(e));
  z.pipe(res);
  done.forEach((c, i) => {
    const base = `clip-${String(i + 1).padStart(2, "0")}-${slug(c.title)}`;
    z.file(c.output_path!, { name: `${base}.mp4` });
    if (c.subtitles_enabled === 1) z.file(c.output_path!.replace(/\.mp4$/, ".srt"), { name: `${base}.srt` });
  });
  void z.finalize();
});

export default r;
