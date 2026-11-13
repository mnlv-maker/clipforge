import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getProjects, mmss, msg, STATUS, type Project } from "../api";

export default function Editor() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getProjects().then(setProjects).catch((reason: unknown) => setError(msg(reason)));
  }, []);

  const editable = projects?.filter((project) => (project.clip_count ?? 0) > 0) ?? [];

  return (
    <section>
      <h1>Editor de clips</h1>
      <p className="muted">Abre un proyecto para revisar sus clips, personalizar subtítulos y encuadre, aplicar cambios y descargar los renders.</p>
      {error && <div className="alert" role="alert">{error}</div>}
      {projects === null && !error && <p className="muted">Cargando proyectos…</p>}
      {projects?.length === 0 && <div className="empty"><p className="empty-title">Aún no hay proyectos</p><p className="muted"><Link to="/crear">Crea un proyecto</Link> para empezar a editar clips.</p></div>}
      {projects && projects.length > 0 && editable.length === 0 && <div className="empty"><p className="empty-title">Todavía no hay clips para editar</p><p className="muted">Abre un proyecto y analiza el vídeo para crear sus primeros clips.</p><Link className="btn" to={`/proyectos/${projects[0].id}`}>Abrir proyecto</Link></div>}
      <div className="grid">
        {editable.map((project) => (
          <article className="card" key={project.id}>
            <h2>{project.name}</h2>
            <p className="muted">{project.clip_count} clips · {mmss(project.duration_s)} de vídeo · {project.width}×{project.height}</p>
            <p><span className="pill">{STATUS[project.status] ?? project.status}</span></p>
            <Link className="btn" to={`/editor/${project.id}`}>Editar clips</Link>
          </article>
        ))}
      </div>
    </section>
  );
}
