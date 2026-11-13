export interface Word { w: string; s: number; e: number }
export interface ScoreBreakdown { hook: number; engagement: number; value: number; shareability: number }
export interface Candidate { start: number; end: number; score: number; text: string; title: string; reason: string; breakdown: ScoreBreakdown }
interface Sentence { s: number; e: number; text: string; n: number; words: Word[] }

const HOOK = /\b(c[oó]mo|por qu[eé]|secreto|nunca|error|verdad|incre[ií]ble|imagina|cuidado|how|why|secret|never|mistake|truth|imagine|stop|biggest|worst|best)\b/i;
const FILLER = /^(eh+|em+|um+|uh+|este|o sea|bueno|pues|like)$/i;
const CONNECT = /^(pero|entonces|y|porque|aunque|and|but|so|because|then)$/i;
const END = /[.!?…]$/;
const CLAUSE_END = /[,;:]$/;
const EMOTION = /\b(brutal|incre[ií]ble|locura|verg[uü]enza|miedo|gracias|llor|r[ií]e|gan[eó]|perd[ií]|joder|hostia|wtf|crazy|insane|win|lost|love|hate|wow)\w*\b/i;

export function sentences(words: Word[]): Sentence[] {
  const out: Sentence[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ s: cur[0].s, e: cur[cur.length - 1].e, text: cur.map((x) => x.w).join(" "), n: cur.length, words: cur });
    cur = [];
  };
  words.forEach((w, i) => {
    cur.push(w);
    const gap = i + 1 < words.length ? words[i + 1].s - w.e : 99;
    if (END.test(w.w) || gap > 0.9 || (cur.length >= 24 && CLAUSE_END.test(w.w)) || cur.length >= 50) flush();
  });
  flush();
  return out;
}

/** Puntuación local 0-100: hook, interés, claridad, contexto, duración y desarrollo. */
function score(win: Sentence[], target: number): { total: number; breakdown: ScoreBreakdown; reason: string } {
  const first = win[0];
  const text = win.map((s) => s.text).join(" ");
  const ws = text.split(/\s+/);
  const dur = win[win.length - 1].e - first.s;
  const hook = Math.min(100, (/\?$/.test(first.text) ? 35 : 0) + (HOOK.test(first.text) ? 40 : 0) + (first.n >= 4 && first.n <= 18 ? 25 : 10));
  const punctuation = Math.min(35, (text.match(/[?!]/g)?.length ?? 0) * 10);
  const avg = ws.length / win.length;
  const fillers = ws.filter((w) => FILLER.test(w.replace(/[.,!?]/g, ""))).length / ws.length;
  const clarity = Math.round(100 * ((avg >= 6 && avg <= 22 ? 0.65 : 0.4) + 0.35 * Math.max(0, 1 - fillers * 10)));
  const context = (END.test(win[win.length - 1].text) ? 25 : 0) + (CONNECT.test(first.text.split(" ")[0].replace(/[.,]/g, "")) ? 0 : 20);
  const fit = Math.round(35 * Math.max(0, 1 - Math.abs(dur - target) / target));
  const wps = ws.length / dur;
  const density = wps >= 1.8 && wps <= 3.5 ? 30 : wps >= 1.2 ? 18 : 8;
  const engagement = Math.min(100, punctuation + fit + density);
  const value = Math.min(100, ( /\d+|paso|consejo|aprend|truc|tip|guide|learn|secret|how to/i.test(text) ? 55 : 20) + (ws.length >= 45 ? 25 : 10) + (END.test(win[win.length - 1].text) ? 20 : 0));
  const shareability = Math.min(100, (HOOK.test(text) ? 35 : 10) + (EMOTION.test(text) ? 30 : 0) + (/[?!]/.test(text) ? 20 : 0) + (/["“”]/.test(text) ? 15 : 0) + (win.length >= 3 ? 20 : 10));
  const breakdown = { hook, engagement, value, shareability };
  const total = Math.round(hook * 0.3 + engagement * 0.3 + value * 0.15 + shareability * 0.25);
  const reason = hook >= 65 ? "Abre con un gancho claro que despierta curiosidad." : engagement >= 65 ? "Mantiene buen ritmo y energía conversacional." : value >= 60 ? "Incluye una idea útil o concreta que la audiencia puede compartir." : shareability >= 60 ? "Tiene una frase o reacción fácil de recordar y compartir." : "Cierra una idea completa y se entiende sin depender del contexto anterior.";
  return { total, breakdown, reason };
}

function withoutEdgeFillers(win: Sentence[]): Sentence[] {
  const cleaned = win.map((sentence) => ({ ...sentence, words: [...sentence.words] }));
  const refresh = (sentence: Sentence) => {
    sentence.s = sentence.words[0].s;
    sentence.e = sentence.words[sentence.words.length - 1].e;
    sentence.n = sentence.words.length;
    sentence.text = sentence.words.map((word) => word.w).join(" ");
  };
  const isFiller = (word: string) => FILLER.test(word.toLowerCase().replace(/^[,.;:!?]+|[,.;:!?]+$/g, "").trim());
  while (cleaned.length && cleaned[0].words.length && isFiller(cleaned[0].words[0].w)) {
    cleaned[0].words.shift();
    if (cleaned[0].words.length) refresh(cleaned[0]);
    else cleaned.shift();
  }
  while (cleaned.length && cleaned[cleaned.length - 1].words.length && isFiller(cleaned[cleaned.length - 1].words.at(-1)!.w)) {
    cleaned[cleaned.length - 1].words.pop();
    if (cleaned[cleaned.length - 1].words.length) refresh(cleaned[cleaned.length - 1]);
    else cleaned.pop();
  }
  return cleaned;
}

export function findClips(words: Word[], durations: number[], count: number): Candidate[] {
  const ss = sentences(words);
  const pool: Candidate[] = [];
  for (const D of durations) {
    for (let i = 0; i < ss.length; i++) {
      let j = i;
      while (j < ss.length && ss[j].e - ss[i].s < D * 0.9) j++;
      if (j >= ss.length) break;
      if (ss[j].e - ss[i].s > D * 1.3) continue;
      const win = withoutEdgeFillers(ss.slice(i, j + 1));
      if (!win.length) continue;
      const evaluated = score(win, D);
      pool.push({
        start: win[0].s,
        end: win[win.length - 1].e,
        score: evaluated.total,
        text: win.map((s) => s.text).join(" "),
        title: win[0].text.replace(/[.!?…,;:]+$/, "").slice(0, 70),
        reason: evaluated.reason,
        breakdown: evaluated.breakdown,
      });
    }
  }
  pool.sort((a, b) => b.score - a.score);
  const picked: Candidate[] = [];
  const finalistLimit = Math.min(40, Math.max(count, count * 6));
  for (const c of pool) {
    if (picked.length >= finalistLimit) break;
    if (picked.every((p) => c.end <= p.start || c.start >= p.end)) picked.push(c); // sin solapes
  }
  return picked.sort((a, b) => a.start - b.start);
}

export function selectTopClips(candidates: Candidate[], count: number): Candidate[] {
  const picked: Candidate[] = [];
  for (const candidate of [...candidates].sort((a, b) => b.score - a.score)) {
    if (picked.length >= count) break;
    if (picked.every((item) => candidate.end <= item.start || candidate.start >= item.end)) picked.push(candidate);
  }
  return picked.sort((a, b) => a.start - b.start);
}

/** Fallback for silent/no-speech sources: distribute safe, non-overlapping sections across the full video. */
export function spreadVisualClips(videoDuration: number, durations: number[], count: number): Candidate[] {
  const available = [...new Set(durations.map((duration) => Math.min(duration, Math.floor(videoDuration))))]
    .filter((duration) => duration >= 5)
    .sort((a, b) => a - b);
  if (!available.length || videoDuration < 5) return [];

  const slotLength = available[available.length - 1];
  const slotCount = Math.max(1, Math.floor(videoDuration / slotLength));
  const clipCount = Math.min(count, slotCount);
  return Array.from({ length: clipCount }, (_, index) => {
    const slot = clipCount === 1 ? 0 : Math.round(index * (slotCount - 1) / (clipCount - 1));
    const duration = available[index % available.length];
    const start = Math.min(slot * slotLength, Math.max(0, videoDuration - duration));
    const number = index + 1;
    return {
      start,
      end: start + duration,
      score: 0,
      title: `Fragmento visual ${String(number).padStart(2, "0")}`,
      text: "Selección visual distribuida automáticamente. El video no tiene voz transcribible.",
      reason: "Fragmento distribuido en la línea de tiempo; no hay voz transcribible para puntuar el potencial.",
      breakdown: { hook: 0, engagement: 0, value: 0, shareability: 0 },
    };
  });
}
