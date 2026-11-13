import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// server/src (o server/dist) -> raíz del repositorio
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
dotenv.config({ path: path.join(root, ".env") });

const num = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return value && Number.isFinite(n) ? n : fallback;
};

const storage = path.resolve(root, process.env.STORAGE_DIR ?? "storage");

export const config = {
  root,
  port: num(process.env.PORT, 4000),
  storage,
  dbPath: path.resolve(root, process.env.DB_PATH ?? "data/clipforge.db"),
  ffmpegBin: process.env.FFMPEG_BIN ?? "ffmpeg",
  ffprobeBin: process.env.FFPROBE_BIN ?? "ffprobe",
  pythonBin: process.env.PYTHON_BIN ?? (process.platform === "win32" ? "python" : "python3"),
  ollamaUrl: process.env.OLLAMA_URL ?? "http://127.0.0.1:11434",
  ollamaModel: process.env.OLLAMA_MODEL ?? "llama3.1:8b",
  // HF_API_KEY is the shared-key name used by ClipForge. Keep legacy names
  // supported so existing installations do not lose their connection.
  higgsfieldCredentials: process.env.HF_API_KEY ?? process.env.HF_CREDENTIALS ?? process.env.HF_KEY ?? "",
  higgsfieldModel: process.env.HF_MODEL ?? "kling-video/v2.6/pro/text-to-video",
  whisperModel: process.env.WHISPER_MODEL ?? "small",
  maxConcurrentJobs: Math.max(1, num(process.env.MAX_CONCURRENT_JOBS, 1)),
};

export const dirs = {
  uploads: path.join(storage, "uploads"),
  transcripts: path.join(storage, "transcripts"),
  work: path.join(storage, "work"),
  exports: path.join(storage, "exports"),
  models: path.join(storage, "models"),
  effects: path.join(storage, "effects"),
};
