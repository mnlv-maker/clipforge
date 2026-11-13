import type { Word } from "./analyze.js";

export const TEMPLATES = {
  mrbeast: { label: "MrBeast", font: "Impact", size: 104, base: "FFFFFF", hl: "FFE600", outline: "000000", ow: 7, bold: 0, italic: 0, upper: true, margin: 560 },
  podcast: { label: "Podcast", font: "Arial", size: 70, base: "FFFFFF", hl: "A78BFA", outline: "000000", ow: 4, bold: 1, italic: 0, upper: false, margin: 380 },
  minimalista: { label: "Minimalista", font: "Arial", size: 62, base: "BDBDBD", hl: "FFFFFF", outline: "000000", ow: 2, bold: 0, italic: 0, upper: false, margin: 260 },
  cinematografico: { label: "Cinematográfico", font: "Georgia", size: 68, base: "F3E3C3", hl: "FFFFFF", outline: "000000", ow: 3, bold: 0, italic: 1, upper: false, margin: 200 },
  gaming: { label: "Gaming", font: "Verdana", size: 84, base: "FFFFFF", hl: "39FF14", outline: "000000", ow: 6, bold: 1, italic: 0, upper: true, margin: 520 },
  ibai: { label: "Resaltado amarillo (streamer)", font: "Impact", size: 92, base: "FFFFFF", hl: "FFD400", outline: "000000", ow: 7, bold: 1, italic: 0, upper: true, margin: 500 },
  educativo: { label: "Educativo", font: "Arial", size: 68, base: "FFFFFF", hl: "4CC9F0", outline: "1B1B2F", ow: 5, bold: 1, italic: 0, upper: false, margin: 340 },
} as const;
export type TemplateId = keyof typeof TEMPLATES;
export interface SubtitleOptions {
  font?: string;
  size?: number;
  color?: string;
  position?: "top" | "middle" | "bottom";
}

const bgr = (rgb: string) => `&H00${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}&`;
const p2 = (n: number) => String(n).padStart(2, "0");
const assTs = (t: number) => {
  const cs = Math.round(Math.max(0, t) * 100);
  return `${Math.floor(cs / 360000)}:${p2(Math.floor(cs / 6000) % 60)}:${p2(Math.floor(cs / 100) % 60)}.${p2(cs % 100)}`;
};
const srtTs = (t: number) => {
  const ms = Math.round(Math.max(0, t) * 1000);
  return `${p2(Math.floor(ms / 3600000))}:${p2(Math.floor(ms / 60000) % 60)}:${p2(Math.floor(ms / 1000) % 60)},${String(ms % 1000).padStart(3, "0")}`;
};

function groups(words: Word[]): Word[][] {
  const out: Word[][] = [];
  let cur: Word[] = [];
  words.forEach((w, i) => {
    cur.push(w);
    const gap = i + 1 < words.length ? words[i + 1].s - w.e : 99;
    if (cur.length >= 4 || /[.!?,;]$/.test(w.w) || gap > 0.5) { out.push(cur); cur = []; }
  });
  if (cur.length) out.push(cur);
  return out;
}

/** Subtítulos palabra por palabra (ASS con la palabra activa resaltada) y SRT. Tiempos relativos al clip. */
export function buildSubs(all: Word[], start: number, end: number, style: TemplateId, options: SubtitleOptions = {}) {
  const t = TEMPLATES[style];
  const font = options.font ?? t.font;
  const size = options.size ?? t.size;
  const baseColor = options.color ?? t.base;
  const position = options.position ?? "bottom";
  const alignment = position === "top" ? 8 : position === "middle" ? 5 : 2;
  const margin = position === "middle" ? 0 : t.margin;
  const rel = all
    .filter((w) => w.s >= start - 0.05 && w.e <= end + 0.05)
    .map((w) => ({ w: w.w.replace(/[{}\\]/g, ""), s: Math.max(0, w.s - start), e: Math.max(0, w.e - start) }));
  const gs = groups(rel);
  const hl = bgr(t.hl);
  const events: string[] = [];
  for (const g of gs) {
    g.forEach((cur, k) => {
      const from = k === 0 ? g[0].s : cur.s;
      const to = Math.max(k + 1 < g.length ? g[k + 1].s : g[g.length - 1].e, from + 0.08);
      const line = g
        .map((x, i) => {
          const txt = t.upper ? x.w.toUpperCase() : x.w;
          return i === k ? `{\\c${hl}\\fscx112\\fscy112}${txt}{\\r}` : txt;
        })
        .join(" ");
      events.push(`Dialogue: 0,${assTs(from)},${assTs(to)},Main,,0,0,0,,${line}`);
    });
  }
  const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Main,${font},${size},${bgr(baseColor)},${bgr(baseColor)},${bgr(t.outline)},&H64000000,${t.bold ? -1 : 0},${t.italic ? -1 : 0},0,0,100,100,0,0,1,${t.ow},2,${alignment},60,60,${margin},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join("\n")}
`;
  const srt = gs.map((g, i) => `${i + 1}\n${srtTs(g[0].s)} --> ${srtTs(g[g.length - 1].e)}\n${g.map((x) => x.w).join(" ")}\n`).join("\n");
  return { ass, srt };
}
