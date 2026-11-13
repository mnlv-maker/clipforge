import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";

const execFileP = promisify(execFile);

export async function probe(file: string) {
  const { stdout } = await execFileP(config.ffprobeBin, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { maxBuffer: 10 * 1024 * 1024 });
  const j = JSON.parse(stdout) as { streams: { codec_type: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string }[]; format: { duration?: string } };
  const v = j.streams.find((s) => s.codec_type === "video");
  if (!v) throw new Error("El archivo no contiene vídeo");
  const rate = v.avg_frame_rate && v.avg_frame_rate !== "0/0" ? v.avg_frame_rate : v.r_frame_rate ?? "30/1";
  const [numerator, denominator] = rate.split("/").map(Number);
  const fps = Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0 ? numerator / denominator : 30;
  return { duration: Number(j.format.duration ?? 0), width: v.width ?? 0, height: v.height ?? 0, fps: Math.min(60, Math.max(1, fps)), hasAudio: j.streams.some((s) => s.codec_type === "audio") };
}

export function run(bin: string, args: string[], opts: { cwd?: string; onLine?: (line: string) => void } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd: opts.cwd, windowsHide: true });
    let err = "";
    p.stdout.on("data", (d) => String(d).split(/\r?\n/).filter(Boolean).forEach((l) => opts.onLine?.(l)));
    p.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(err.trim().split("\n").slice(-3).join(" ") || `${bin} terminó con código ${code}`)),
    );
  });
}
