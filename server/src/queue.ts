import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config, dirs } from "./config.js";
import { db } from "./db.js";

type Report = (progress: number, message: string) => void;
interface Job { id: string; run: (report: Report) => Promise<void>; retries: number; onFail?: (msg: string) => void }

const waiting: Job[] = [];
let active = 0;

function set(id: string, status: string, progress?: number, message?: string, error?: string) {
  db.prepare("UPDATE jobs SET status=?, progress=COALESCE(?,progress), message=COALESCE(?,message), error=?, updated_at=datetime('now') WHERE id=?")
    .run(status, progress ?? null, message ?? null, error ?? null, id);
}

async function exec(job: Job) {
  active++;
  for (let attempt = 1; attempt <= job.retries + 1; attempt++) {
    try {
      db.prepare("UPDATE jobs SET attempts=? WHERE id=?").run(attempt, job.id);
      set(job.id, "running");
      await job.run((p, m) => set(job.id, "running", p, m));
      set(job.id, "done", 100, "Listo");
      break;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt > job.retries) {
        set(job.id, "error", undefined, undefined, msg);
        job.onFail?.(msg);
      }
    }
  }
  active--;
  pump();
}

function pump() {
  while (active < config.maxConcurrentJobs && waiting.length) void exec(waiting.shift()!);
}

export function enqueue(type: string, projectId: string, run: Job["run"], onFail?: Job["onFail"], retries = 1) {
  const id = randomUUID();
  db.prepare("INSERT INTO jobs (id, project_id, type, message) VALUES (?,?,?,?)").run(id, projectId, type, "En cola");
  waiting.push({ id, run, retries, onFail });
  pump();
}

function removeIfUnlocked(target: string) {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EBUSY" || code === "EACCES") {
      console.warn(`Se conserva el temporal bloqueado y se continuará el arranque: ${target}`);
      return;
    }
    throw error;
  }
}

/** Al arrancar: recupera trabajos interrumpidos sin fallar por temporales bloqueados en Windows. */
export function recover() {
  db.prepare("UPDATE jobs SET status='error', error='Interrumpido al reiniciar' WHERE status IN ('queued','running')").run();
  db.prepare("UPDATE projects SET status='created' WHERE status='processing'").run();
  const interrupted = db.prepare("SELECT id,source_path FROM projects WHERE status IN ('recording','stopping')").all() as { id: string; source_path: string }[];
  for (const project of interrupted) {
    // Ask a detached yt-dlp capture process to stop cleanly. Preserve its partial
    // MP4: Windows may keep it locked until that process flushes and exits.
    fs.writeFileSync(path.join(dirs.work, `${project.id}.stop`), "stop");
    db.prepare("UPDATE projects SET status='error',has_audio=0,error='Captura interrumpida al reiniciar el servidor; se conservó el archivo parcial' WHERE id=?").run(project.id);
  }
  db.prepare("UPDATE clips SET status='pending' WHERE status='rendering'").run();
  for (const entry of fs.readdirSync(dirs.work)) {
    if (interrupted.some((item) => entry === `${item.id}.stop`)) continue;
    removeIfUnlocked(path.join(dirs.work, entry));
  }
  fs.mkdirSync(dirs.work, { recursive: true });
}
