export interface Check { id: string; label: string; ok: boolean; optional: boolean; phase: number; detail: string }
export interface SystemInfo {
  checks: Check[];
  config: { port: number; storageDir: string; whisperModel: string; ollamaModel: string; maxConcurrentJobs: number; higgsfieldConfigured: boolean };
}
export interface Project {
  id: string; name: string; duration_s: number; width: number; height: number; fps: number;
  has_audio: number; status: string; created_at: string; clip_count?: number;
  layout: string; subtitles_enabled: number; error: string | null; source_url: string | null;
}
export interface FacecamRect { x: number; y: number; width: number; height: number }
export type EditMode = "traditional" | "split-screen" | "ibai" | "face-tracking";
export interface Clip {
  id: string; start_s: number; end_s: number; score: number; title: string; text: string; reason: string; score_breakdown: string; style: string; status: string;
  edit_mode: EditMode; subtitles_enabled: number; distribution: "automatic" | "custom";
  camera_height: number; facecam_mode: "automatic" | "manual"; facecam_rect: string | null;
  facecam_detection: string | null; facecam_status: string; subtitle_font: string; subtitle_size: number;
  subtitle_color: string; subtitle_position: "top" | "middle" | "bottom";
  motion_status: "idle" | "generating" | "ready" | "error" | "canceled"; motion_has_audio: number;
}
export interface Job { type: string; status: string; progress: number; message: string | null; error: string | null; activeCount?: number }
export interface CaptureProgress { startedAt: number; elapsedSeconds: number; bytes: number }
export interface Detail { project: Project; clips: Clip[]; job: Job | null; capture: CaptureProgress | null }
export interface Template { id: string; label: string }

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error("No hay conexión con el servidor. Ejecuta npm run dev en la raíz del proyecto.");
  }
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `El servidor respondió ${res.status}`);
  return data as T;
}
const post = <T>(url: string, body?: unknown) =>
  call<T>(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });

export const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
export const STATUS: Record<string, string> = { created: "Sin analizar", recording: "Capturando live", stopping: "Finalizando captura", processing: "Procesando", ready: "Con clips", error: "Con error" };

export const getSystem = () => call<SystemInfo>("/api/system");
export const saveHiggsfieldKey = (key: string) => call<{ configured: boolean; saved: boolean; validityVerified: false }>("/api/settings/higgsfield-key", {
  method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }),
});
export const removeHiggsfieldKey = () => call<{ configured: boolean }>("/api/settings/higgsfield-key", { method: "DELETE" });
export const getProjects = () => call<Project[]>("/api/projects");
export const getProject = (id: string) => call<Detail>(`/api/projects/${id}`);
export const getTemplates = () => call<Template[]>("/api/templates");
export const createProject = (form: FormData) => call<Project>("/api/projects", { method: "POST", body: form });
export const createYoutubeProject = (url: string, name: string, mode: "video" | "live", authorized: boolean, subtitlesEnabled: boolean) =>
  post<Project>("/api/projects/youtube", { url, name, mode, authorized, subtitlesEnabled });
export const stopLiveCapture = (id: string) => post<Project>(`/api/projects/${id}/stop-capture`);
export const updateProjectLayout = (id: string, layout: string) =>
  call<Project>(`/api/projects/${id}/layout`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ layout }),
  });
export const analyze = (id: string, body: { durations: number[]; count: number; style: string; layout: string; editMode: EditMode; subtitlesEnabled: boolean }) => post(`/api/projects/${id}/analyze`, body);
export const renderClip = (id: string, style: string) => post(`/api/clips/${id}/render`, { style });
export const renderAll = (id: string) => post(`/api/projects/${id}/render-all`);
export const generateHiggsfieldIntro = (id: string) => post<{ ok: boolean }>(`/api/clips/${id}/higgsfield-intro`);
export const cancelHiggsfieldIntro = (id: string) => post<{ ok: boolean; status: string }>(`/api/clips/${id}/higgsfield-intro/cancel`);
export const updateClipSettings = (id: string, settings: Partial<{
  editMode: EditMode;
  subtitlesEnabled: boolean;
  distribution: "automatic" | "custom";
  cameraHeight: number;
  facecamMode: "automatic" | "manual";
  facecamRect: FacecamRect | null;
  style: string;
  subtitleFont: string;
  subtitleSize: number;
  subtitleColor: string;
  subtitlePosition: "top" | "middle" | "bottom";
}>) => call<Clip>(`/api/clips/${id}/settings`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(settings),
});
export const detectFacecam = (id: string) => post<{ found: boolean; status: string }>(`/api/clips/${id}/detect-facecam`);
export const deleteProject = (id: string) => call(`/api/projects/${id}`, { method: "DELETE" });
