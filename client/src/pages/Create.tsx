import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { createProject, createYoutubeProject, msg } from "../api";

export default function Create() {
  const nav = useNavigate();
  const [source, setSource] = useState<"file" | "video" | "live">("file");
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [subtitlesEnabled, setSubtitlesEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const uploadVideo = async (videoFile: File) => {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      if (name.trim()) form.append("name", name.trim());
      form.append("subtitlesEnabled", String(subtitlesEnabled));
      form.append("video", videoFile);
      const p = await createProject(form);
      nav(`/proyectos/${p.id}`);
    } catch (e) {
      setError(msg(e));
      setBusy(false);
    }
  };

  const submit = async () => {
    if (source === "file") {
      if (file) await uploadVideo(file);
      return;
    }
    if (!url.trim() || !authorized) return;
    setBusy(true);
    setError(null);
    try {
      const p = await createYoutubeProject(url.trim(), name.trim(), source, authorized, subtitlesEnabled);
      nav(`/proyectos/${p.id}`);
    } catch (e) {
      setError(msg(e));
      setBusy(false);
    }
  };

  return (
    <section>
      <h1>Crear proyecto</h1>
      <p className="muted">Sube un vídeo o pega un enlace de YouTube o Kick. Después elegirás cuántos clips quieres y de qué duración.</p>
      {error && <div className="alert" role="alert" style={{ marginTop: 20 }}>{error}</div>}
      <div className="form">
        <div className="row" role="group" aria-label="Origen del video">
          <button type="button" className={`btn ${source === "file" ? "" : "ghost"}`} onClick={() => setSource("file")}>Subir archivo</button>
          <button type="button" className={`btn ${source === "video" ? "" : "ghost"}`} onClick={() => setSource("video")}>Video o VOD</button>
          <button type="button" className={`btn ${source === "live" ? "" : "ghost"}`} onClick={() => setSource("live")}>Grabar un live</button>
        </div>
        <div className="field">
          <label htmlFor="name">Nombre del proyecto</label>
          <input id="name" type="text" value={name} placeholder="Si lo dejas vacío, uso el nombre del archivo o video" onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label>Subtítulos</label>
          <label className="chk">
            <input type="checkbox" checked={subtitlesEnabled} onChange={(e) => setSubtitlesEnabled(e.target.checked)} />
            {subtitlesEnabled ? "Con subtítulos automáticos" : "Sin subtítulos"}
          </label>
          <p className="muted">
            {subtitlesEnabled
              ? "Se generarán subtítulos automáticamente para los clips."
              : "Los clips se exportarán sin texto generado; el audio original se conserva y no se procesarán transcripciones para subtítulos."}
          </p>
        </div>
        {source === "file" ? (
          <div className="field">
            <label htmlFor="video">Vídeo (MP4, MOV, MKV, WEBM, AVI o M4V)</label>
            <input id="video" type="file" accept="video/*,.mkv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            {file && <p className="muted">Archivo listo: {file.name}</p>}
          </div>
        ) : (
          <>
            <div className="field">
              <label htmlFor="youtube-url">Enlace de YouTube o Kick</label>
              <input id="youtube-url" type="text" inputMode="url" value={url} placeholder="https://youtube.com/... o https://kick.com/..." onChange={(e) => setUrl(e.target.value)} />
            </div>
            <p className="muted">YouTube y Kick se importan con yt-dlp en la mejor calidad disponible. Kick admite VODs, clips y grabación de canales en vivo.</p>
            <label className="chk">
              <input type="checkbox" checked={authorized} onChange={(e) => setAuthorized(e.target.checked)} />
              Confirmo que el contenido es mío o tengo permiso para descargarlo y crear clips.
            </label>
            {source === "live" && <p className="muted">Usa el enlace de un canal en vivo. La captura sigue hasta que pulses “Detener captura” en el proyecto y puede ocupar bastante espacio en disco.</p>}
          </>
        )}
        <div>
          <button className="btn" type="button" disabled={busy || (source === "file" ? !file : !url.trim() || !authorized)} onClick={() => void submit()}>
            {busy ? "Importando el vídeo…" : source === "file" ? "Crear proyecto" : source === "live" ? "Iniciar captura del live" : "Descargar vídeo y crear proyecto"}
          </button>
        </div>
      </div>
    </section>
  );
}
