import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";

const execFileAsync = promisify(execFile);

export interface Check {
  id: string;
  label: string;
  ok: boolean;
  optional: boolean;
  phase: number; // primera fase que necesita esta herramienta
  detail: string;
}

interface Result {
  ok: boolean;
  out: string;
}

async function run(bin: string, args: string[], timeout = 15000): Promise<Result> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, { timeout, windowsHide: true });
    return { ok: true, out: (stdout || stderr).trim() };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === "ENOENT") return { ok: false, out: "No encontrado en el PATH" };
    const lines = (err.stderr || err.message || "Error desconocido").trim().split("\n");
    return { ok: false, out: lines[lines.length - 1] };
  }
}

const pyModule = (mod: string) =>
  run(config.pythonBin, ["-c", `import ${mod} as m; print(getattr(m, '__version__', 'instalado'))`], 45000);

async function ollama(): Promise<Result> {
  try {
    const res = await fetch(`${config.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { ok: false, out: `Ollama respondió HTTP ${res.status}` };
    const data = (await res.json()) as { models?: { name: string }[] };
    const names = (data.models ?? []).map((m) => m.name);
    const found = names.some((n) => n === config.ollamaModel || n.startsWith(`${config.ollamaModel}:`));
    return found
      ? { ok: true, out: `Modelo ${config.ollamaModel} disponible` }
      : { ok: false, out: `Falta el modelo. Ejecuta: ollama pull ${config.ollamaModel}` };
  } catch {
    return { ok: false, out: `Sin respuesta en ${config.ollamaUrl}` };
  }
}

const first = (s: string) => (s.split("\n")[0] ?? s).replace(/\s+Copyright.*$/, "");

export async function systemCheck(): Promise<Check[]> {
  const [ffmpeg, ffprobe, python, fw, yt, cv, mp, wx, ol] = await Promise.all([
    run(config.ffmpegBin, ["-version"]),
    run(config.ffprobeBin, ["-version"]),
    run(config.pythonBin, ["--version"]),
    pyModule("faster_whisper"),
    pyModule("yt_dlp"),
    pyModule("cv2"),
    pyModule("mediapipe"),
    pyModule("whisperx"),
    ollama(),
  ]);

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const row = (id: string, label: string, phase: number, optional: boolean, r: Result): Check => ({
    id, label, phase, optional, ok: r.ok, detail: first(r.out),
  });

  return [
    row("node", "Node.js", 1, false, { ok: nodeMajor >= 20, out: `v${process.versions.node}${nodeMajor >= 20 ? "" : " (se requiere 20 o superior)"}` }),
    row("ffmpeg", "FFmpeg", 2, false, ffmpeg),
    row("ffprobe", "FFprobe", 2, false, ffprobe),
    row("python", "Python", 3, false, python),
    row("faster_whisper", "Faster-Whisper", 3, false, fw),
    row("yt_dlp", "yt-dlp (enlaces de YouTube)", 2, true, yt),
    row("whisperx", "WhisperX", 3, true, wx),
    row("ollama", "Ollama", 4, true, ol),
    row("opencv", "OpenCV", 6, false, cv),
    row("mediapipe", "MediaPipe", 6, false, mp),
  ];
}
