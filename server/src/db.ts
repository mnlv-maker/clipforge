import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config.js";

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  source_path TEXT,
  source_url  TEXT,
  duration_s  REAL,
  width       INTEGER,
  height      INTEGER,
  fps         REAL NOT NULL DEFAULT 30,
  has_audio   INTEGER,
  layout      TEXT NOT NULL DEFAULT 'center',
  subtitles_enabled INTEGER NOT NULL DEFAULT 1,
  error       TEXT,
  status      TEXT NOT NULL DEFAULT 'created',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id         TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'queued',
  attempts   INTEGER NOT NULL DEFAULT 0,
  progress   REAL NOT NULL DEFAULT 0,
  error      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS clips (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  start_s     REAL NOT NULL,
  end_s       REAL NOT NULL,
  score       INTEGER NOT NULL,
  title       TEXT NOT NULL,
  text        TEXT NOT NULL,
  reason      TEXT NOT NULL DEFAULT '',
  score_breakdown TEXT NOT NULL DEFAULT '{"hook":0,"engagement":0,"value":0,"shareability":0}',
  style       TEXT NOT NULL DEFAULT 'mrbeast',
  edit_mode   TEXT NOT NULL DEFAULT 'traditional',
  subtitles_enabled INTEGER NOT NULL DEFAULT 1,
  distribution TEXT NOT NULL DEFAULT 'automatic',
  camera_height INTEGER NOT NULL DEFAULT 50,
  facecam_mode TEXT NOT NULL DEFAULT 'automatic',
  facecam_rect TEXT,
  facecam_detection TEXT,
  facecam_status TEXT NOT NULL DEFAULT 'idle',
  motion_path TEXT,
  motion_status TEXT NOT NULL DEFAULT 'idle',
  motion_has_audio INTEGER NOT NULL DEFAULT 0,
  motion_request_id TEXT,
  motion_cancel_url TEXT,
  subtitle_font TEXT NOT NULL DEFAULT 'Impact',
  subtitle_size INTEGER NOT NULL DEFAULT 104,
  subtitle_color TEXT NOT NULL DEFAULT 'FFFFFF',
  subtitle_position TEXT NOT NULL DEFAULT 'bottom',
  status      TEXT NOT NULL DEFAULT 'pending',
  output_path TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
try { db.exec("ALTER TABLE jobs ADD COLUMN message TEXT"); } catch { /* ya existe */ }

const projectColumns = db.pragma("table_info(projects)") as { name: string }[];
if (!projectColumns.some((column) => column.name === "source_url")) db.exec("ALTER TABLE projects ADD COLUMN source_url TEXT");
if (!projectColumns.some((column) => column.name === "layout")) db.exec("ALTER TABLE projects ADD COLUMN layout TEXT NOT NULL DEFAULT 'center'");
if (!projectColumns.some((column) => column.name === "subtitles_enabled")) db.exec("ALTER TABLE projects ADD COLUMN subtitles_enabled INTEGER NOT NULL DEFAULT 1");
if (!projectColumns.some((column) => column.name === "error")) db.exec("ALTER TABLE projects ADD COLUMN error TEXT");
if (!projectColumns.some((column) => column.name === "fps")) db.exec("ALTER TABLE projects ADD COLUMN fps REAL NOT NULL DEFAULT 30");

const clipColumns = db.pragma("table_info(clips)") as { name: string }[];
const clipMigrations: [string, string][] = [
  ["reason", "TEXT NOT NULL DEFAULT ''"],
  ["score_breakdown", "TEXT NOT NULL DEFAULT '{\"hook\":0,\"engagement\":0,\"value\":0,\"shareability\":0}'"],
  ["edit_mode", "TEXT NOT NULL DEFAULT 'traditional'"],
  ["subtitles_enabled", "INTEGER NOT NULL DEFAULT 1"],
  ["distribution", "TEXT NOT NULL DEFAULT 'automatic'"],
  ["camera_height", "INTEGER NOT NULL DEFAULT 50"],
  ["facecam_mode", "TEXT NOT NULL DEFAULT 'automatic'"],
  ["facecam_rect", "TEXT"],
  ["facecam_detection", "TEXT"],
  ["facecam_status", "TEXT NOT NULL DEFAULT 'idle'"],
  ["motion_path", "TEXT"],
  ["motion_status", "TEXT NOT NULL DEFAULT 'idle'"],
  ["motion_has_audio", "INTEGER NOT NULL DEFAULT 0"],
  ["motion_request_id", "TEXT"],
  ["motion_cancel_url", "TEXT"],
  ["subtitle_font", "TEXT NOT NULL DEFAULT 'Impact'"],
  ["subtitle_size", "INTEGER NOT NULL DEFAULT 104"],
  ["subtitle_color", "TEXT NOT NULL DEFAULT 'FFFFFF'"],
  ["subtitle_position", "TEXT NOT NULL DEFAULT 'bottom'"],
];
for (const [name, definition] of clipMigrations) {
  if (!clipColumns.some((column) => column.name === name)) {
    db.exec(`ALTER TABLE clips ADD COLUMN ${name} ${definition}`);
  }
}

export interface ProjectRow {
  id: string; name: string; source_path: string; source_url: string | null;
  duration_s: number; width: number; height: number; fps: number; has_audio: number;
  layout: string; subtitles_enabled: number; error: string | null; status: string;
}
export interface ClipRow {
  id: string; project_id: string; start_s: number; end_s: number; score: number; title: string; text: string; reason: string; score_breakdown: string; style: string;
  edit_mode: string; subtitles_enabled: number; distribution: string; camera_height: number;
  facecam_mode: string; facecam_rect: string | null; facecam_detection: string | null; facecam_status: string;
  motion_path: string | null; motion_status: string; motion_has_audio: number;
  motion_request_id: string | null; motion_cancel_url: string | null;
  subtitle_font: string; subtitle_size: number; subtitle_color: string; subtitle_position: string;
  status: string; output_path: string | null;
}
