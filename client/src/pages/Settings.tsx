import { useEffect, useState } from "react";
import { getSystem, msg, removeHiggsfieldKey, saveHiggsfieldKey, type SystemInfo } from "../api";

export default function Settings() {
  const [cfg, setCfg] = useState<SystemInfo["config"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keyDialog, setKeyDialog] = useState(false);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = () => getSystem().then((s) => setCfg(s.config)).catch((e: unknown) => setError(msg(e)));
  useEffect(() => { void refresh(); }, []);

  async function connectKey() {
    setSaving(true); setError(null); setNotice(null);
    try {
      await saveHiggsfieldKey(key);
      setKey(""); setKeyDialog(false);
      setNotice("API key saved. La validez de la clave todavía no se ha verificado.");
      await refresh();
    } catch (e) { setError(msg(e)); }
    finally { setSaving(false); }
  }

  async function disconnectKey() {
    setSaving(true); setError(null); setNotice(null);
    try {
      await removeHiggsfieldKey(); setKeyDialog(false); setKey("");
      setNotice("API key eliminada de la configuración local."); await refresh();
    } catch (e) { setError(msg(e)); }
    finally { setSaving(false); }
  }

  const rows: [string, string | number][] = cfg
    ? [
        ["Carpeta de almacenamiento", cfg.storageDir],
        ["Modelo de Whisper", cfg.whisperModel],
        ["Modelo de Ollama", cfg.ollamaModel],
        ["Higgsfield API", cfg.higgsfieldConfigured ? "API key saved (validity not verified)" : "No conectada"],
        ["Trabajos simultáneos", cfg.maxConcurrentJobs],
        ["Puerto del servidor", cfg.port],
      ]
    : [];

  return (
    <section>
      <h1>Configuración</h1>
      <p className="muted">Los valores de procesamiento se leen del archivo .env. La API key de Higgsfield se guarda solo en el servidor y no se devuelve al navegador.</p>
      {error && <div className="alert" role="alert">{error}</div>}
      {notice && <div className="notice" role="status">{notice}</div>}
      {cfg && (
        <>
          <dl className="kv">
            {rows.map(([k, v]) => (
              <div key={k} className="kv-row">
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          <div className="panel key-panel">
            <div>
              <h2>Higgsfield</h2>
              <p className="muted">Conecta tu clave para generar intros animadas. Se guarda en el archivo .env del servidor; nunca se lee desde el cliente.</p>
            </div>
            <button className="btn" onClick={() => { setKey(""); setError(null); setKeyDialog(true); }}>
              {cfg.higgsfieldConfigured ? "Manage API key" : "Connect API key"}
            </button>
          </div>
        </>
      )}

      {keyDialog && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setKeyDialog(false); }}>
          <section className="key-dialog" role="dialog" aria-modal="true" aria-labelledby="higgsfield-key-title">
            <div className="page-head">
              <div><h2 id="higgsfield-key-title">{cfg?.higgsfieldConfigured ? "Manage API key" : "Connect API key"}</h2>
                <p className="muted">Paste the API key copied from open.higgsfield.ai. Paste it as-is.</p></div>
              <button className="btn ghost" disabled={saving} onClick={() => setKeyDialog(false)} aria-label="Cerrar">×</button>
            </div>
            <label className="field">
              <span>{cfg?.higgsfieldConfigured ? "Replace API key" : "API key"}</span>
              <input type="password" value={key} onChange={(event) => setKey(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="Pega la clave completa" />
            </label>
            <p className="muted key-security">La clave no se mostrará ni se enviará a Higgsfield hasta que solicites una generación. Guardarla no comprueba que sea válida.</p>
            {error && <div className="alert" role="alert">{error}</div>}
            <div className="row dialog-actions">
              {cfg?.higgsfieldConfigured && <button className="btn ghost danger" disabled={saving} onClick={() => void disconnectKey()}>Remove API key</button>}
              <button className="btn" disabled={saving || !key.length} onClick={() => void connectKey()}>
                {saving ? "Guardando…" : cfg?.higgsfieldConfigured ? "Replace API key" : "Connect API key"}
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
