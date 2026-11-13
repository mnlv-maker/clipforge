import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { probe } from "./media.js";

interface HiggsfieldResult {
  request_id?: string;
  status?: string;
  status_url?: string;
  cancel_url?: string;
  video?: { url?: string };
  error?: string | { message?: string };
}

const endpoint = `https://api.higgsfield.ai/${config.higgsfieldModel}`;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function checkedApiUrl(raw: string | undefined, label: string) {
  if (!raw) throw new Error(`Higgsfield no devolvió la URL para ${label}.`);
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.hostname !== "api.higgsfield.ai") {
    throw new Error(`Higgsfield devolvió una URL de ${label} inesperada.`);
  }
  return url.toString();
}

function getError(data: HiggsfieldResult) {
  if (typeof data.error === "string") return data.error;
  if (data.error?.message) return data.error.message;
  return `La generación terminó con estado ${data.status ?? "desconocido"}.`;
}

class HiggsfieldHttpError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterMs?: number) { super(message); }
}

async function apiJson(url: string, init?: RequestInit): Promise<HiggsfieldResult> {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Key ${config.higgsfieldCredentials}`, "Content-Type": "application/json", ...init?.headers },
    signal: AbortSignal.timeout(45000),
  });
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message : `Higgsfield respondió HTTP ${response.status}.`;
    const rawRetry = response.headers.get("retry-after");
    const seconds = rawRetry ? Number(rawRetry) : NaN;
    const retryAfterMs = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : undefined;
    throw new HiggsfieldHttpError(message, response.status, retryAfterMs);
  }
  return body as HiggsfieldResult;
}

function delay(ms: number) { return wait(Math.max(250, Math.min(ms, 30000))); }

export async function cancelHiggsfieldRequest(cancelUrl: string) {
  const checkedUrl = checkedApiUrl(cancelUrl, "cancelación");
  return apiJson(checkedUrl, { method: "POST", body: "{}" });
}

export async function generateHiggsfieldIntro(
  title: string,
  outputPath: string,
  report: (progress: number, message: string) => void,
  onSubmitted: (data: { requestId: string; cancelUrl: string }) => void,
) {
  const prompt = [
    "Create a 5-second vertical motion-graphics stinger for a Spanish-language gaming or livestream highlight.",
    `Theme inspired by this short clip title: ${title.slice(0, 120)}.`,
    "Use fast kinetic shapes, a brief camera push-in, high-contrast dark charcoal with electric yellow and cyan accents, a clean impact flash, and one short synchronized whoosh/impact sound effect.",
    "No logos, no readable text, no extra people, no speech. Keep the action legible in the center safe area.",
  ].join(" ");
  report(8, "Solicitando motion graphic y sonido a Higgsfield");
  let result = await apiJson(endpoint, {
    method: "POST",
    body: JSON.stringify({ prompt, duration: 5, aspect_ratio: "9:16", sound: "on", cfg_scale: 0.5 }),
  });
  if (!result.request_id || !result.status_url || !result.cancel_url) {
    throw new Error("Higgsfield no devolvió los datos necesarios para seguir y cancelar la generación.");
  }
  let statusUrl = checkedApiUrl(result.status_url, "consultar el progreso");
  const cancelUrl = checkedApiUrl(result.cancel_url, "cancelación");
  onSubmitted({ requestId: result.request_id, cancelUrl });
  let pollMs = 2000;
  const deadline = Date.now() + 10 * 60 * 1000;
  let attempt = 0;
  while (!result.video?.url && Date.now() < deadline) {
    const status = result.status?.toLowerCase();
    if (status === "failed" || status === "nsfw" || status === "canceled" || status === "cancelled") {
      const terminal = status.startsWith("cancel") ? "cancelada" : status === "nsfw" ? "bloqueada por la política de contenido" : "fallida";
      throw new Error(`Generación ${terminal}: ${getError(result)}`);
    }
    if (status === "completed") break;
    if (status && status !== "queued" && status !== "in_progress") {
      throw new Error(`Higgsfield devolvió un estado de generación desconocido: ${status}.`);
    }
    report(Math.min(82, 18 + Math.floor(attempt / 2)), status === "queued" ? "Generación en cola en Higgsfield" : "Higgsfield está generando la animación y el sonido");
    await delay(pollMs);
    try {
      result = await apiJson(statusUrl, { method: "GET" });
      if (result.status_url) statusUrl = checkedApiUrl(result.status_url, "consultar el progreso");
      pollMs = Math.min(15000, Math.round(pollMs * 1.4));
      attempt++;
    } catch (error) {
      if (!(error instanceof HiggsfieldHttpError) || (error.status !== 429 && error.status < 500)) throw error;
      const backoff = error.retryAfterMs ?? pollMs;
      report(Math.min(82, 18 + Math.floor(attempt / 2)), "Higgsfield limitó temporalmente las consultas; reintentando el estado");
      pollMs = Math.min(30000, Math.max(backoff, Math.round(pollMs * 2)));
    }
  }
  if (!result.video?.url) throw new Error("Higgsfield tardó demasiado en completar la generación.");

  const videoUrl = new URL(result.video.url);
  if (videoUrl.protocol !== "https:") throw new Error("Higgsfield devolvió un enlace de video no seguro.");
  report(88, "Descargando la motion graphic generada");
  const response = await fetch(videoUrl, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`No se pudo descargar el resultado de Higgsfield (HTTP ${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 100_000 || bytes.length > 250 * 1024 * 1024) throw new Error("El archivo generado tiene un tamaño inesperado.");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, bytes);
  const media = await probe(outputPath);
  if (!media.hasAudio) {
    await fs.rm(outputPath, { force: true });
    throw new Error("Higgsfield devolvió el video sin sonido; vuelve a generar el efecto.");
  }
  report(96, "Motion graphic y sonido listos");
  return { hasAudio: media.hasAudio };
}
