import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getProjects, mmss, msg, STATUS, type Project } from "../api";

export default function Projects() {
  const [items, setItems] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getProjects().then(setItems).catch((e: unknown) => setError(msg(e)));
  }, []);

  return (
    <section>
      <h1>Mis proyectos</h1>
      {error && <div className="alert" role="alert" style={{ marginTop: 20 }}>{error}</div>}
      {items?.length === 0 && (
        <div className="empty">
          <p className="empty-title">Aún no tienes proyectos</p>
          <p className="muted">Sube tu primer vídeo para generar clips. <Link to="/crear">Crear proyecto</Link></p>
        </div>
      )}
      <div className="grid">
        {items?.map((p) => (
          <Link key={p.id} to={`/proyectos/${p.id}`} className="card">
            <h3>{p.name}</h3>
            <p className="muted">{p.status === "recording" ? "Capturando transmisión en vivo" : p.status === "stopping" ? "Finalizando captura" : `${mmss(p.duration_s)} de vídeo, ${p.width}x${p.height}`}</p>
            <p style={{ marginTop: 10 }}>
              <span className="pill">{STATUS[p.status] ?? p.status}</span>{" "}
              {p.clip_count ? <span className="muted">{p.clip_count} clips</span> : null}
            </p>
          </Link>
        ))}
      </div>
    </section>
  );
}
