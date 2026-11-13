import { config } from "./config.js";
import type { Candidate, ScoreBreakdown } from "./analyze.js";

interface OllamaResponse { message?: { content?: string } }

function validScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

function parseResults(content: string, candidates: Candidate[]): Candidate[] | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { clips?: unknown }).clips)) return null;
    const byIndex = new Map<number, Candidate>();
    for (const item of (parsed as { clips: unknown[] }).clips) {
      if (!item || typeof item !== "object") return null;
      const row = item as { index?: unknown; title?: unknown; reason?: unknown; score?: unknown; breakdown?: Partial<ScoreBreakdown> };
      if (!Number.isInteger(row.index) || typeof row.index !== "number" || row.index < 0 || row.index >= candidates.length) return null;
      if (typeof row.title !== "string" || typeof row.reason !== "string" || !validScore(row.score)) return null;
      const parts = row.breakdown;
      if (!parts || !validScore(parts.hook) || !validScore(parts.engagement) || !validScore(parts.value) || !validScore(parts.shareability)) return null;
      const original = candidates[row.index];
      byIndex.set(row.index, {
        ...original,
        title: row.title.trim().slice(0, 80) || original.title,
        reason: row.reason.trim().slice(0, 220) || original.reason,
        score: Math.round(row.score),
        breakdown: { hook: Math.round(parts.hook), engagement: Math.round(parts.engagement), value: Math.round(parts.value), shareability: Math.round(parts.shareability) },
      });
    }
    return byIndex.size === candidates.length ? [...byIndex.values()] : null;
  } catch {
    return null;
  }
}

/** Ask local Ollama to score only transcript finalists. Any outage or invalid response preserves the local scores. */
export async function rankWithOllama(candidates: Candidate[]): Promise<Candidate[]> {
  if (!candidates.length) return candidates;
  try {
    const response = await fetch(`${config.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(90000),
      body: JSON.stringify({
        model: config.ollamaModel,
        stream: false,
        format: "json",
        options: { temperature: 0.15 },
        messages: [
          { role: "system", content: "Evalúas clips cortos para redes. Puntúa solo con evidencia del texto; no inventes eventos de audio o video. Conserva los índices y tiempos implícitos. Devuelve JSON estricto: {\"clips\":[{\"index\":0,\"title\":\"título gancho\",\"reason\":\"por qué funciona\",\"score\":0,\"breakdown\":{\"hook\":0,\"engagement\":0,\"value\":0,\"shareability\":0}}]}. Cada número va de 0 a 100. Escribe títulos y razones en español, manteniendo el idioma original cuando una traducción resulte extraña." },
          { role: "user", content: JSON.stringify(candidates.map((candidate, index) => ({ index, seconds: Math.round(candidate.end - candidate.start), transcript: candidate.text.slice(0, 2600), initialScore: candidate.score }))) },
        ],
      }),
    });
    if (!response.ok) return candidates;
    const data = (await response.json()) as OllamaResponse;
    return parseResults(data.message?.content ?? "", candidates) ?? candidates;
  } catch {
    return candidates;
  }
}
