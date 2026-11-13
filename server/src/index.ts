import fs from "node:fs";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { config, dirs } from "./config.js";
import { recover } from "./queue.js";
import routes from "./routes.js";
import { systemCheck } from "./system.js";

for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
recover();

const app = express();
app.use(cors({ origin: /^http:\/\/(localhost|127\.0\.0\.1):\d+$/ }));
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, name: "clipforge-ai", version: "0.2.0" });
});

app.get("/api/system", async (_req, res) => {
  res.json({
    checks: await systemCheck(),
    config: {
      port: config.port,
      storageDir: config.storage,
      whisperModel: config.whisperModel,
      ollamaModel: config.ollamaModel,
      maxConcurrentJobs: config.maxConcurrentJobs,
      higgsfieldConfigured: Boolean(config.higgsfieldCredentials),
    },
  });
});

app.use("/api", routes);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err instanceof Error ? err.message : "Error interno" });
});

app.listen(config.port, () => {
  console.log(`ClipForge AI (API) en http://localhost:${config.port}`);
});
