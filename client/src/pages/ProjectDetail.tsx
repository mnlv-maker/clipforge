import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { analyze, cancelHiggsfieldIntro, deleteProject, detectFacecam, generateHiggsfieldIntro, getProject, getTemplates, mmss, msg, renderAll, renderClip, stopLiveCapture, updateClipSettings, updateProjectLayout, type Clip, type Detail, type EditMode, type FacecamRect, type Template } from "../api";

const PRESETS = [15, 30, 45, 60, 90];
const viralLevel = (score: number) => score >= 70 ? "Alto" : score >= 40 ? "Medio" : "Bajo";
const liveClock = (seconds: number) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
};
function scoreMetrics(serialized: string): [string, number][] {
  try {
    const value = JSON.parse(serialized) as { hook?: unknown; engagement?: unknown; value?: unknown; shareability?: unknown };
    return [
      ["Gancho", value.hook], ["Interacción", value.engagement],
      ["Valor", value.value], ["Compartible", value.shareability],
    ].filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]));
  } catch { return []; }
}

function storedCameraRect(clip: Clip): FacecamRect | null {
  if (clip.facecam_mode === "manual" && clip.facecam_rect) {
    try { return JSON.parse(clip.facecam_rect) as FacecamRect; } catch { return null; }
  }
  if (!clip.facecam_detection) return null;
  try {
    return (JSON.parse(clip.facecam_detection) as { selected?: { roi?: FacecamRect } }).selected?.roi ?? null;
  } catch {
    return null;
  }
}

function SplitPreview({ projectId, clip, cameraHeight, rect }: {
  projectId: string; clip: Clip; cameraHeight: number; rect: FacecamRect | null;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const duration = Math.max(0, clip.end_s - clip.start_s + 0.5);
  const [progress, setProgress] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!video || !canvas || !context) return;
    let frame = 0;
    let ticks = 0;
    const draw = () => {
      const topHeight = Math.round(canvas.height * cameraHeight / 100);
      const bottomHeight = canvas.height - topHeight;
      context.fillStyle = "#000";
      context.fillRect(0, 0, canvas.width, canvas.height);
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
        const scale = Math.max(canvas.width / video.videoWidth, bottomHeight / video.videoHeight);
        const sourceWidth = canvas.width / scale;
        const sourceHeight = bottomHeight / scale;
        context.drawImage(
          video,
          (video.videoWidth - sourceWidth) / 2,
          (video.videoHeight - sourceHeight) / 2,
          sourceWidth,
          sourceHeight,
          0,
          topHeight,
          canvas.width,
          bottomHeight,
        );
        if (rect) {
          const targetRatio = canvas.width / topHeight;
          let cameraWidth = rect.width * video.videoWidth;
          let cameraHeightPixels = rect.height * video.videoHeight;
          let cameraX = rect.x * video.videoWidth;
          let cameraY = rect.y * video.videoHeight;
          if (cameraWidth / cameraHeightPixels > targetRatio) {
            const croppedWidth = cameraHeightPixels * targetRatio;
            cameraX += (cameraWidth - croppedWidth) / 2;
            cameraWidth = croppedWidth;
          } else {
            const croppedHeight = cameraWidth / targetRatio;
            cameraY += (cameraHeightPixels - croppedHeight) / 2;
            cameraHeightPixels = croppedHeight;
          }
          context.drawImage(
            video,
            cameraX,
            cameraY,
            cameraWidth,
            cameraHeightPixels,
            0,
            0,
            canvas.width,
            topHeight,
          );
        } else {
          context.fillStyle = "#17171b";
          context.fillRect(0, 0, canvas.width, topHeight);
          context.fillStyle = "#b5b5bf";
          context.font = "16px sans-serif";
          context.textAlign = "center";
          context.fillText("Detecta o selecciona la cámara", canvas.width / 2, topHeight / 2);
        }
      }
      if (!video.paused && video.currentTime >= clip.end_s + 0.3) {
        video.pause();
        setPlaying(false);
      }
      if (ticks++ % 8 === 0) setProgress(Math.max(0, Math.min(duration, video.currentTime - clip.start_s)));
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [cameraHeight, clip.end_s, clip.start_s, duration, rect?.height, rect?.width, rect?.x, rect?.y]);

  const seek = (value: string) => {
    const next = Number(value);
    if (videoRef.current) videoRef.current.currentTime = clip.start_s + next;
    setProgress(next);
  };
  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      if (video.currentTime < clip.start_s || video.currentTime >= clip.end_s + 0.3) video.currentTime = clip.start_s;
      void video.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    } else {
      video.pause();
      setPlaying(false);
    }
  };

  return (
    <div className="split-preview">
      <video
        ref={videoRef}
        className="preview-source"
        src={`/api/projects/${projectId}/source`}
        muted
        preload="metadata"
        aria-hidden="true"
        onLoadedMetadata={(event) => { event.currentTarget.currentTime = clip.start_s; }}
        onEnded={() => setPlaying(false)}
      />
      <canvas ref={canvasRef} width={270} height={480} aria-label="Vista previa del clip dividido" />
      <div className="preview-controls">
        <button className="btn ghost" onClick={togglePlayback}>{playing ? "Pausar" : "Reproducir"}</button>
        <input aria-label="Posición de la vista previa" type="range" min={0} max={duration} step={0.1} value={progress} onChange={(event) => seek(event.target.value)} />
        <span className="muted">{mmss(progress)}</span>
      </div>
      <p className="muted">Vista previa del encuadre. Los subtítulos se aplican al exportar.</p>
    </div>
  );
}

function RegionPicker({ projectId, clip, sourceWidth, sourceHeight, rect, onSave }: {
  projectId: string; clip: Clip; sourceWidth: number; sourceHeight: number; rect: FacecamRect | null;
  onSave: (value: FacecamRect) => Promise<void>;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [draft, setDraft] = useState<FacecamRect | null>(rect);

  useEffect(() => setDraft(rect), [rect]);

  const point = (event: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    };
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!selecting) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    origin.current = point(event);
    setDraft({ ...origin.current, width: 0, height: 0 });
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!origin.current) return;
    const current = point(event);
    setDraft({
      x: Math.min(origin.current.x, current.x),
      y: Math.min(origin.current.y, current.y),
      width: Math.abs(current.x - origin.current.x),
      height: Math.abs(current.y - origin.current.y),
    });
  };
  const onPointerUp = async (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!origin.current) return;
    const current = point(event);
    const next = {
      x: Math.min(origin.current.x, current.x),
      y: Math.min(origin.current.y, current.y),
      width: Math.abs(current.x - origin.current.x),
      height: Math.abs(current.y - origin.current.y),
    };
    origin.current = null;
    setSelecting(false);
    if (next.width >= 0.02 && next.height >= 0.02) {
      setDraft(next);
      await onSave(next);
    }
  };

  return (
    <div className="region-picker">
      <p className="muted">Arrastra para marcar únicamente el recuadro de la cámara.</p>
      <div
        className={`region-stage${selecting ? " selecting" : ""}`}
        style={{
          aspectRatio: `${sourceWidth || 16}/${sourceHeight || 9}`,
          width: `min(100%, ${Math.min(480, 360 * (sourceWidth || 16) / (sourceHeight || 9))}px)`,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => void onPointerUp(event)}
        onPointerCancel={() => { origin.current = null; setSelecting(false); }}
      >
        <video
          ref={videoRef}
          src={`/api/projects/${projectId}/source`}
          controls={!selecting}
          preload="metadata"
          onLoadedMetadata={(event) => { event.currentTarget.currentTime = clip.start_s; }}
        />
        {draft && <div className="region-box" style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, width: `${draft.width * 100}%`, height: `${draft.height * 100}%` }} />}
      </div>
      <button className="btn ghost" onClick={() => {
        if (selecting) return;
        videoRef.current?.pause();
        setSelecting(true);
      }}>{selecting ? "Arrastra en el video…" : rect ? "Cambiar área de cámara" : "Seleccionar área manualmente"}</button>
    </div>
  );
}

function TikTokPreview({ clip }: { clip: Clip }) {
  return (
    <div className="tiktok-preview" aria-label="Vista previa del video vertical en TikTok">
      {clip.status === "done" ? (
        <video src={`/api/clips/${clip.id}/video`} controls preload="metadata" />
      ) : (
        <div className="tiktok-empty">
          <strong>{clip.status === "rendering" ? "Renderizando…" : "Vista previa TikTok"}</strong>
          <span>{clip.status === "rendering" ? "El resultado aparecerá aquí" : "Renderiza el clip para ver el resultado final"}</span>
        </div>
      )}
      <div className="tiktok-topbar"><span>◀</span><strong>Para ti</strong><span>⌕</span></div>
      <div className="tiktok-actions" aria-hidden="true"><span>♥</span><span>●</span><span>↗</span></div>
      <div className="tiktok-caption"><strong>@{clip.title.slice(0, 18) || "clipforge"}</strong><span>{clip.title}</span></div>
    </div>
  );
}

export default function ProjectDetail() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const [d, setD] = useState<Detail | null>(null);
  const [tpl, setTpl] = useState<Template[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [durs, setDurs] = useState<number[]>([30, 60]);
  const [custom, setCustom] = useState("");
  const [count, setCount] = useState(5);
  const [style, setStyle] = useState("mrbeast");
  const [layout, setLayout] = useState("center");
  const [editMode, setEditMode] = useState<EditMode>("split-screen");
  const [subtitlesEnabled, setSubtitlesEnabled] = useState(true);
  const [previewOpen, setPreviewOpen] = useState<Record<string, boolean>>({});
  const [detecting, setDetecting] = useState<Record<string, boolean>>({});
  const [preparingRender, setPreparingRender] = useState<Record<string, boolean>>({});
  const renderRequests = useRef(new Set<string>());
  const [clockNow, setClockNow] = useState(Date.now());

  const load = useCallback(async () => {
    try {
      setD(await getProject(id));
    } catch (e) {
      setError(msg(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
    getTemplates().then(setTpl).catch(() => undefined);
  }, [load]);

  useEffect(() => {
    if (d?.project.layout) setLayout(d.project.layout);
    if (d?.project) setSubtitlesEnabled(d.project.subtitles_enabled !== 0);
  }, [d?.project.id]);

  const busy = d?.project.status === "processing" || d?.project.status === "recording" ||
    d?.project.status === "stopping" || d?.clips.some((c) => c.status === "rendering") ||
    d?.clips.some((c) => c.motion_status === "generating") ||
    Object.values(detecting).some(Boolean) || Object.values(preparingRender).some(Boolean);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [busy, load]);

  useEffect(() => {
    if (!d?.capture) return;
    const t = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [d?.capture?.startedAt]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(msg(e));
    }
  };

  const updateClip = async (clipId: string, settings: Parameters<typeof updateClipSettings>[1]) => {
    await act(() => updateClipSettings(clipId, settings));
  };

  const renderOne = (clip: Clip) => {
    if (renderRequests.current.has(clip.id)) return;
    renderRequests.current.add(clip.id);
    return act(async () => {
      setPreparingRender((current) => ({ ...current, [clip.id]: true }));
      try {
        if (clip.edit_mode === "split-screen" && clip.facecam_mode === "manual" && !storedCameraRect(clip)) {
          throw new Error("Selecciona el área de la cámara antes de renderizar.");
        }
        if ((clip.edit_mode === "face-tracking" || (clip.edit_mode === "split-screen" && clip.facecam_mode === "automatic")) && !storedCameraRect(clip)) {
          setDetecting((current) => ({ ...current, [clip.id]: true }));
          try { await detectFacecam(clip.id); }
          finally { setDetecting((current) => ({ ...current, [clip.id]: false })); }
        }
        await renderClip(clip.id, clip.style);
      } finally {
        renderRequests.current.delete(clip.id);
        setPreparingRender((current) => ({ ...current, [clip.id]: false }));
      }
    });
  };

  const renderPending = () => act(async () => {
    for (const clip of clips.filter((item) => item.status === "pending" || item.status === "error")) {
      if (clip.edit_mode === "split-screen" && clip.facecam_mode === "manual" && !storedCameraRect(clip)) {
        throw new Error(`Selecciona el área de cámara de “${clip.title}” antes de renderizar todos.`);
      }
      if ((clip.edit_mode === "face-tracking" || (clip.edit_mode === "split-screen" && clip.facecam_mode === "automatic")) && !storedCameraRect(clip)) {
        await detectFacecam(clip.id);
      }
    }
    await renderAll(id);
  });

  const detectClipCamera = (clip: Clip) => act(async () => {
    setDetecting((current) => ({ ...current, [clip.id]: true }));
    try {
      const result = await detectFacecam(clip.id);
      if (!result.found) setError("No se encontró una cámara. Cambia a selección manual y marca el recuadro.");
    } finally {
      setDetecting((current) => ({ ...current, [clip.id]: false }));
    }
  });

  if (!d) return <section><h1>Proyecto</h1>{error ? <div className="alert" role="alert">{error}</div> : <p className="muted">Cargando</p>}</section>;

  const { project: p, clips, job } = d;
  const processing = p.status === "processing";
  const recording = p.status === "recording" || p.status === "stopping";
  const elapsed = d.capture ? Math.max(0, Math.floor((clockNow - d.capture.startedAt) / 1000)) : 0;
  const processProgress = Math.max(0, Math.min(100, Math.round(job?.progress ?? 0)));
  const formatBytes = (bytes: number) => bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  const allDurs = [...durs, ...(Number(custom) >= 5 ? [Number(custom)] : [])];
  const done = clips.filter((c) => c.status === "done").length;
  const visualOnly = (clip: Clip) => clip.text.startsWith("Selección visual ");

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>{p.name}</h1>
          {recording
            ? <p className="muted">{p.status === "stopping" ? "Finalizando y guardando la captura…" : "Capturando la transmisión en vivo"}</p>
            : <p className="muted">{mmss(p.duration_s)} · fuente {p.width}×{p.height} a {Number(p.fps || 30).toFixed(p.fps % 1 ? 2 : 0)} fps · exportación vertical Full HD 1080×1920 a {Math.min(60, Number(p.fps || 30)).toFixed(p.fps % 1 ? 2 : 0)} fps{p.has_audio ? "" : " · sin audio"}</p>}
        </div>
        <button className="btn ghost" disabled={recording} onClick={() => { if (confirm("¿Borrar este proyecto y sus clips?")) void act(async () => { await deleteProject(id); nav("/proyectos"); }); }}>
          Borrar proyecto
        </button>
      </div>

      {error && <div className="alert" role="alert">{error}</div>}
      {p.status === "error" && <div className="alert" role="alert">{p.error ?? job?.error ?? "El proyecto terminó con error."}</div>}
      {job?.status === "error" && job.error && <div className="alert" role="alert">No se pudo completar {job.type === "render" ? "el render" : job.type === "higgsfield" ? "la generación de Higgsfield" : "el análisis"}: {job.error}</div>}

      {recording && (
        <div className="panel">
          <h2>Transmisión en vivo</h2>
          <p className="muted">Tiempo grabando: <strong>{liveClock(elapsed)}</strong> · Guardado: <strong>{formatBytes(d.capture?.bytes ?? 0)}</strong></p>
          <div className="bar live-progress" role="progressbar" aria-label="Grabación en vivo en curso"><div /></div>
          <p className="muted note">La grabación no tiene duración final definida. La barra indica que sigue activa; el tamaño y el tiempo se actualizan automáticamente.</p>
          <div>
            <button className="btn" disabled={p.status === "stopping"} onClick={() => void act(() => stopLiveCapture(id))}>
              {p.status === "stopping" ? "Finalizando captura…" : "Detener captura y preparar proyecto"}
            </button>
          </div>
        </div>
      )}

      {!recording && (processing || clips.some((clip) => clip.status === "rendering" || clip.motion_status === "generating")) && (
        <div className="panel process-progress" aria-live="polite">
          <div className="page-head"><strong>{job?.message ?? (processing ? "Analizando el video" : "Renderizando clips")}</strong><span>{processProgress}%</span></div>
          <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={processProgress}><div style={{ width: `${processProgress}%` }} /></div>
          <p className="muted note">{job?.type === "higgsfield" ? "Higgsfield genera una animación vertical con un efecto de sonido; luego se añadirá al principio del render." : job?.type === "render" ? `Aplicando encuadre, audio y subtítulos${job.activeCount && job.activeCount > 1 ? ` · ${job.activeCount} tareas de render activas` : ""}.` : "El progreso se actualiza automáticamente."}</p>
        </div>
      )}

      {!recording && (
        <div className="panel">
        <h2>Generar clips</h2>
        <div className="field">
          <label htmlFor="edit-mode">Estilo de edición</label>
          <select id="edit-mode" value={editMode} onChange={(e) => {
            const mode = e.target.value as EditMode;
            setEditMode(mode);
            if (mode === "ibai") {
              setStyle("ibai");
              setSubtitlesEnabled(true);
              setLayout("center");
            }
          }}>
            <option value="ibai">Edición tipo Ibai · gameplay a pantalla completa</option>
            <option value="face-tracking">Seguimiento de cara + zoom vertical</option>
            <option value="split-screen">Cámara arriba / contenido abajo (50/50)</option>
            <option value="traditional">Edición tradicional vertical</option>
          </select>
          {editMode === "ibai" && <p className="muted">Gameplay a pantalla completa, recorte vertical centrado, sin facecam ni bandas borrosas; subtítulos grandes con palabra activa amarilla.</p>}
          {editMode === "face-tracking" && <p className="muted">Detecta el rostro durante todo el clip, aplica zoom vertical y suaviza el movimiento para mantener a la persona encuadrada.</p>}
          {editMode === "split-screen" && <p className="muted">La cámara queda arriba y el contenido principal abajo, en mitades iguales. Si no se detecta, podrás marcarla manualmente.</p>}
        </div>
        {editMode === "traditional" && <div className="field">
          <label htmlFor="layout">Composición vertical</label>
          <select id="layout" value={layout} onChange={(e) => {
            const next = e.target.value;
            setLayout(next);
            void act(() => updateProjectLayout(id, next));
          }}>
            <option value="center">Video normal: recorte vertical centrado</option>
            <option value="reaction-left">Reacción izquierda arriba / gameplay abajo</option>
            <option value="reaction-right">Reacción derecha arriba / gameplay abajo</option>
          </select>
          {layout !== "center" && <p className="muted">Cada mitad ocupa el 50%: reacción arriba y gameplay abajo.</p>}
        </div>}
        <div className="row">
          {PRESETS.map((n) => (
            <label key={n} className="chk">
              <input type="checkbox" checked={durs.includes(n)} onChange={(e) => setDurs(e.target.checked ? [...durs, n] : durs.filter((x) => x !== n))} />
              {n} s
            </label>
          ))}
          <label className="chk">
            Otra duración
            <input type="number" min={5} max={300} value={custom} onChange={(e) => setCustom(e.target.value)} style={{ width: 80 }} />
          </label>
        </div>
        <div className="row">
          <label className="chk">Cantidad de clips
            <input type="number" min={1} max={20} value={count} onChange={(e) => setCount(Number(e.target.value))} style={{ width: 70 }} />
          </label>
          <label className="chk">Plantilla de subtítulos
            <select value={subtitlesEnabled ? style : "none"} onChange={(e) => {
              if (e.target.value === "none") setSubtitlesEnabled(false);
              else {
                setStyle(e.target.value);
                setSubtitlesEnabled(true);
              }
            }}>
              <option value="none">Sin subtítulos</option>
              {tpl.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </label>
          <button className="btn" disabled={processing || !allDurs.length} onClick={() => void act(() => analyze(id, { durations: allDurs, count, style, layout, editMode, subtitlesEnabled }))}>
            {clips.length ? "Buscar clips de nuevo" : p.has_audio ? "Buscar clips" : "Buscar fragmentos visuales"}
          </button>
        </div>
        {!p.has_audio && <p className="muted">Este video no tiene audio: se crearán fragmentos distribuidos a lo largo del video, sin transcripción ni subtítulos.</p>}

        {processing && (
          <div>
            <div className="bar"><div style={{ width: `${job?.progress ?? 0}%` }} /></div>
            <p className="muted note" style={{ marginTop: 8 }}>{job?.message ?? "Procesando"}. La primera transcripción es la más lenta; después se reutiliza.</p>
          </div>
        )}
        </div>
      )}

      {clips.length > 0 && <p className="muted note">La viralidad es una estimación orientativa (0–100), basada en señales del texto y la duración; no garantiza reproducciones.</p>}
      {clips.length > 0 && (
        <>
          <div className="page-head" style={{ marginBottom: 14 }}>
            <h2>{clips.length} clips, {done} renderizados</h2>
            <div className="row">
              <button className="btn ghost" disabled={done === clips.length || !!busy} onClick={() => void renderPending()}>Renderizar todos</button>
              {done > 0 && <a className="btn" href={`/api/projects/${id}/zip`}>Descargar ZIP</a>}
            </div>
          </div>
          <ul className="clips">
            {clips.map((c) => (
              <li key={c.id} className="clip">
                <div className="clip-media"><TikTokPreview clip={c} /></div>
                <div>
                  <div className="clip-top"><span className="score" title={visualOnly(c) ? "No se evaluó el potencial: el video no tiene voz transcribible." : `Estimación orientativa: ${c.score} de 100`}>{visualOnly(c) ? "—" : c.score}</span><span className="viral-level">{visualOnly(c) ? "No evaluado" : `Potencial ${viralLevel(c.score)}`}</span><strong>{c.title}</strong></div>
                  <p className="muted" style={{ fontSize: 13 }}>{mmss(c.start_s)} a {mmss(c.end_s)}, {Math.round(c.end_s - c.start_s)} s</p>
                  <p className="clip-text">{c.text}</p>
                  <div className="viral-explanation">
                    <strong>Por qué puede funcionar</strong>
                    <span>{c.reason || "La selección prioriza frases completas, claridad y ritmo."}</span>
                    {!visualOnly(c) && <div className="viral-metrics">
                      {scoreMetrics(c.score_breakdown).map(([label, value]) => <span key={label}>{label} <b>{value}</b></span>)}
                    </div>}
                  </div>
                  {c.status === "done" && <div className="clip-settings">
                    <label className="field">
                      Estilo de edición
                      <select value={c.edit_mode} onChange={(e) => {
                        const mode = e.target.value as EditMode;
                        void updateClip(c.id, mode === "ibai"
                          ? { editMode: mode, style: "ibai", subtitlesEnabled: true, distribution: "automatic" }
                          : { editMode: mode });
                      }}>
                        <option value="ibai">Tipo Ibai · juego completo</option>
                        <option value="face-tracking">Seguimiento de cara + zoom</option>
                        <option value="traditional">Tradicional</option>
                        <option value="split-screen">Cámara arriba / contenido abajo</option>
                      </select>
                    </label>
                    <label className="field">Plantilla de subtítulos
                      <select value={c.subtitles_enabled === 1 ? c.style : "none"} onChange={(e) => {
                        const value = e.target.value;
                        void updateClip(c.id, value === "none"
                          ? { subtitlesEnabled: false }
                          : { subtitlesEnabled: true, style: value });
                      }}>
                        <option value="none">Sin subtítulos</option>
                        {tpl.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                      </select>
                    </label>
                    {c.edit_mode === "ibai" && <p className="muted">Gameplay vertical a pantalla completa, sin facecam ni fondo borroso; el recorte sigue el centro del cuadro.</p>}
                    {c.edit_mode === "face-tracking" && <p className="muted">El render detecta y sigue el rostro con un zoom vertical suave.</p>}
                    {c.subtitles_enabled === 1 && (
                      <div className="subtitle-options">
                        <label className="field">Tipografía
                          <select value={c.subtitle_font} onChange={(e) => void updateClip(c.id, { subtitleFont: e.target.value })}>
                            {["Impact", "Arial", "Verdana", "Georgia", "Trebuchet MS"].map((font) => <option key={font}>{font}</option>)}
                          </select>
                        </label>
                        <label className="field">Tamaño
                          <input type="number" min={24} max={160} value={c.subtitle_size} onChange={(e) => {
                            const value = Number(e.target.value);
                            if (value >= 24 && value <= 160) void updateClip(c.id, { subtitleSize: value });
                          }} />
                        </label>
                        <label className="field">Color
                          <input type="color" value={`#${c.subtitle_color}`} onChange={(e) => void updateClip(c.id, { subtitleColor: e.target.value.slice(1) })} />
                        </label>
                        <label className="field">Posición
                          <select value={c.subtitle_position} onChange={(e) => void updateClip(c.id, { subtitlePosition: e.target.value as "top" | "middle" | "bottom" })}>
                            <option value="top">Arriba</option>
                            <option value="middle">Centro</option>
                            <option value="bottom">Abajo</option>
                          </select>
                        </label>
                      </div>
                    )}
                    {c.edit_mode === "split-screen" && (
                      <>
                        <p className="muted">
                          {c.facecam_mode === "manual"
                            ? storedCameraRect(c) ? "Área manual seleccionada." : "Selecciona el área de cámara en el video original."
                            : c.facecam_status === "ready" ? "Cámara detectada; puedes revisar el encuadre en la vista previa." :
                              c.facecam_status === "not-found" ? "No se encontró una cámara automáticamente; usa la selección manual." :
                                c.facecam_status === "error" ? "La detección falló; revisa el sistema o selecciona el área manualmente." :
                                  "La cámara se detectará automáticamente al renderizar."}
                        </p>
                        <div className="split-settings">
                          <label className="field">Distribución
                            <select value={c.distribution} onChange={(e) => void updateClip(c.id, { distribution: e.target.value as "automatic" | "custom" })}>
                              <option value="automatic">Automática (50% / 50%)</option>
                              <option value="custom">Personalizada</option>
                            </select>
                          </label>
                          {c.distribution === "custom" && <label className="field">Altura de cámara (%)
                            <input type="number" min={30} max={70} value={c.camera_height} onChange={(e) => {
                              const value = Number(e.target.value);
                              if (Number.isInteger(value) && value >= 30 && value <= 70) void updateClip(c.id, { cameraHeight: value });
                            }} />
                          </label>}
                          <label className="field">Detección de cámara
                            <select value={c.facecam_mode} onChange={(e) => void updateClip(c.id, { facecamMode: e.target.value as "automatic" | "manual" })}>
                              <option value="automatic">Automática</option>
                              <option value="manual">Seleccionar manualmente</option>
                            </select>
                          </label>
                          {c.facecam_mode === "automatic" && (
                            <button className="btn ghost" disabled={!!detecting[c.id]} onClick={() => void detectClipCamera(c)}>
                              {detecting[c.id] ? "Detectando…" : c.facecam_status === "ready" ? "Volver a detectar" : "Detectar cámara"}
                            </button>
                          )}
                        </div>
                        {c.facecam_mode === "manual" && (
                          <RegionPicker
                            projectId={p.id}
                            clip={c}
                            sourceWidth={p.width}
                            sourceHeight={p.height}
                            rect={storedCameraRect(c)}
                            onSave={(rect) => updateClip(c.id, { facecamMode: "manual", facecamRect: rect })}
                          />
                        )}
                        <button className="btn ghost" onClick={() => setPreviewOpen((current) => ({ ...current, [c.id]: !current[c.id] }))}>
                          {previewOpen[c.id] ? "Ocultar vista previa" : "Vista previa"}
                        </button>
                        {previewOpen[c.id] && (
                          <SplitPreview projectId={p.id} clip={c} cameraHeight={c.distribution === "automatic" ? 50 : c.camera_height} rect={storedCameraRect(c)} />
                        )}
                      </>
                    )}
                  </div>}
                  <div className="clip-actions">
                    {c.status === "done" && <button className="btn ghost" disabled={c.motion_status === "generating"} onClick={() => {
                      if (confirm("Higgsfield enviará el título del clip y generará un video con sonido. Esta operación consume saldo de tu cuenta Higgsfield según el modelo y su duración. ¿Continuar?")) {
                        void act(() => generateHiggsfieldIntro(c.id));
                      }
                    }}>
                      {c.motion_status === "generating" ? "Generando motion graphic…" : c.motion_status === "ready" ? "Regenerar intro + sonido" : "Generar intro + sonido con Higgsfield"}
                    </button>}
                    {c.motion_status === "generating" && <button className="btn ghost danger" onClick={() => void act(() => cancelHiggsfieldIntro(c.id))}>Cancelar generación</button>}
                    <button className="btn" disabled={c.status === "rendering" || !!preparingRender[c.id]} onClick={() => void renderOne(c)}>
                      {c.status === "rendering" ? "Renderizando…" : detecting[c.id] ? "Detectando cámara…" : preparingRender[c.id] ? "Preparando render…" : c.status === "done" ? "Aplicar cambios" : "Renderizar"}
                    </button>
                    {c.motion_status === "ready" && <span className="muted">La próxima renderización añadirá 1,35 s de intro animada y sonido.</span>}
                    {c.motion_status === "error" && <span className="muted">Higgsfield no pudo generar el efecto. Puedes intentarlo de nuevo.</span>}
                    {c.motion_status === "canceled" && <span className="muted">Generación de Higgsfield cancelada.</span>}
                    {c.status === "done" && <a className="btn ghost" href={`/api/clips/${c.id}/mp4`}>MP4</a>}
                    {c.status === "done" && c.subtitles_enabled === 1 && <a className="btn ghost" href={`/api/clips/${c.id}/srt`}>SRT</a>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
