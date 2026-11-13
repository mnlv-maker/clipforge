import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { getProjects, getSystem, type SystemInfo } from "../api";

export default function Dashboard() {
  const [sys, setSys] = useState<SystemInfo | null>(null);
  const [projects, setProjects] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, p] = await Promise.all([getSystem(), getProjects()]);
      setSys(s);
      setProjects(p.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const checks = sys?.checks ?? [];
  const ready = checks.filter((c) => c.ok).length;
  const missingRequired = checks.filter((c) => !c.ok && !c.optional).length;

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p className="muted">
            {sys
              ? `${ready} de ${checks.length} herramientas listas. ${projects} proyectos creados.`
              : "Comprobando las herramientas locales."}
          </p>
        </div>
        <button className="btn" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={16} className={loading ? "spin" : ""} />
          {loading ? "Comprobando" : "Volver a comprobar"}
        </button>
      </div>

      {error && <div className="alert" role="alert">{error}</div>}

      {sys && (
        <>
          <h2>Herramientas del entorno</h2>
          {missingRequired > 0 && (
            <p className="muted note">
              Instala las que faltan antes de llegar a la fase que las usa. Python: pip install -r python/requirements.txt
            </p>
          )}
          <ul className="checks">
            {checks.map((c) => (
              <li key={c.id} className="check">
                <span className={`dot ${c.ok ? "" : c.optional ? "warn" : "bad"}`} title={c.ok ? "Listo" : c.optional ? "Opcional, no instalado" : "Falta"} />
                <div>
                  <div className="check-label">{c.label}</div>
                  <div className="check-detail">{c.detail}</div>
                </div>
                <span className="pill">{c.ok ? "Listo" : c.optional ? "Opcional" : `Falta, Fase ${c.phase}`}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
