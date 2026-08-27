import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import "dotenv/config";
import {
  SESSION_COOKIE,
  checkPassword,
  credentialsConfigured,
  createToken,
  SESSION_TTL_SECONDS,
  verifyToken,
} from "./auth";
import {
  deleteProspect,
  getActivities,
  getDue,
  getMetrics,
  getProspect,
  getProspects,
  getSettings,
  insertProspect,
  saveSettings,
  updateProspect,
} from "./db";
import { advanceProspect, exportCsv, parseCsv, setStatus, logNote } from "./outreach";
import { generateMessage } from "./ai";
import { createProspect, todayISO, uid } from "./store";
import { Prospect, ProspectStatus, Settings } from "./types";

const app = express();
const PORT = Number(process.env.PORT || 4000);

const corsOrigins = (process.env.CORS_ORIGIN || "http://localhost:3000")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: corsOrigins,
    credentials: true,
  })
);
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

function sendError(res: express.Response, status: number, message: string) {
  res.status(status).json({ error: message });
}

async function requireAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const token = (req as express.Request & { cookies?: Record<string, string> })
    .cookies?.[SESSION_COOKIE];
  if (!token || !(await verifyToken(token))) {
    return sendError(res, 401, "Unauthorized");
  }
  next();
}

function setSessionCookie(res: express.Response, token: string) {
  const secure = process.env.NODE_ENV === "production";
  const sameSite = (process.env.COOKIE_SAMESITE || (secure ? "none" : "lax")) as
    | "lax"
    | "none"
    | "strict";
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite,
    domain: process.env.COOKIE_DOMAIN || undefined,
    path: "/",
    maxAge: SESSION_TTL_SECONDS * 1000,
  });
}

const VALID_STATUS: ProspectStatus[] = [
  "new",
  "contacted",
  "replied",
  "interested",
  "closed",
  "dead",
];

/* ---------- Auth ---------- */

app.post("/api/login", async (req, res) => {
  if (!credentialsConfigured()) {
    return sendError(
      res,
      500,
      "ADMIN_USERNAME, ADMIN_PASSWORD dan SESSION_SECRET belum dikonfigurasi."
    );
  }
  const { username, password } = req.body ?? {};
  if (
    !username ||
    username !== process.env.ADMIN_USERNAME ||
    !checkPassword(String(password ?? ""))
  ) {
    return sendError(res, 401, "Username atau password salah.");
  }
  const token = await createToken(String(username));
  setSessionCookie(res, token);
  res.json({ ok: true });
});

app.get("/api/logout", (req, res) => {
  res.clearCookie(SESSION_COOKIE, {
    domain: process.env.COOKIE_DOMAIN || undefined,
    path: "/",
  });
  res.json({ ok: true });
});

app.get("/api/me", async (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token || !(await verifyToken(token))) {
    return sendError(res, 401, "Unauthorized");
  }
  res.json({ username: "admin" });
});

/* ---------- Protected routes ---------- */

app.use(requireAuth);

app.get("/api/stats", async (_req, res) => {
  const metrics = await getMetrics();
  res.json({ metrics });
});

app.get("/api/outreach", async (_req, res) => {
  const due = await getDue();
  res.json({ due });
});

app.get("/api/prospects", async (_req, res) => {
  const prospects = await getProspects();
  res.json({ prospects });
});

app.post("/api/prospects", async (req, res) => {
  const body = req.body ?? {};
  if (!body.name) return sendError(res, 400, "name is required");
  const prospect = { ...createProspect(body), id: uid("p_"), createdAt: todayISO() };
  await insertProspect(prospect);
  res.status(201).json({ prospect });
});

app.post("/api/prospects/import", async (req, res) => {
  const csv = req.body?.csv;
  if (!csv) return sendError(res, 400, "csv is required");
  const imported = parseCsv(String(csv));
  for (const p of imported) await insertProspect(p);
  res.status(201).json({ imported: imported.length });
});

app.get("/api/prospects/export", async (_req, res) => {
  const prospects = await getProspects();
  const csv = exportCsv(prospects);
  res
    .setHeader("Content-Type", "text/csv; charset=utf-8")
    .setHeader("Content-Disposition", 'attachment; filename="prospects.csv"')
    .send(csv);
});

app.get("/api/prospects/:id", async (req, res) => {
  const p = await getProspect(req.params.id);
  if (!p) return sendError(res, 404, "not found");
  res.json({ prospect: p });
});

app.patch("/api/prospects/:id", async (req, res) => {
  const current = await getProspect(req.params.id);
  if (!current) return sendError(res, 404, "not found");
  const body = req.body ?? {};
  if (body.name !== undefined && !String(body.name).trim()) {
    return sendError(res, 400, "Name cannot be empty");
  }
  const allowed = ["name", "company", "channel", "contact", "segment", "notes"];
  const patch: Record<string, string> = {};
  for (const k of allowed) {
    if (body[k] !== undefined) patch[k] = String(body[k]).trim();
  }
  const updated = await updateProspect(req.params.id, patch);
  res.json({ prospect: updated });
});

app.delete("/api/prospects/:id", async (req, res) => {
  const ok = await deleteProspect(req.params.id);
  if (!ok) return sendError(res, 404, "not found");
  res.json({ removed: true });
});

app.post("/api/prospects/:id/status", async (req, res) => {
  const body = req.body ?? {};
  const status = String(body.status ?? "");
  if (!VALID_STATUS.includes(status as ProspectStatus)) {
    return sendError(res, 400, "invalid status");
  }
  const updated = await setStatus(req.params.id, status as ProspectStatus, {
    note: body.note,
    value: body.value !== undefined ? Number(body.value) : undefined,
  });
  if (!updated) return sendError(res, 404, "not found");
  res.json({ prospect: updated });
});

app.post("/api/prospects/:id/advance", async (req, res) => {
  const settings = await getSettings();
  const updated = await advanceProspect(req.params.id, {
    message: req.body?.message,
    seq: settings.sequence,
  });
  if (!updated) return sendError(res, 404, "not found");
  res.json({ prospect: updated });
});

app.post("/api/prospects/:id/note", async (req, res) => {
  if (!(await getProspect(req.params.id))) return sendError(res, 404, "not found");
  await logNote(req.params.id, String(req.body?.note ?? ""));
  res.json({ ok: true });
});

app.get("/api/prospects/:id/activities", async (req, res) => {
  const activities = await getActivities(req.params.id);
  res.json({ activities });
});

app.post("/api/prospects/:id/message", async (req, res) => {
  const [p, settings] = await Promise.all([
    getProspect(req.params.id),
    getSettings(),
  ]);
  if (!p) return sendError(res, 404, "not found");
  const step =
    typeof req.body?.step === "number" && req.body.step >= 0
      ? Math.min(req.body.step, settings.sequence.length - 1)
      : Math.min(p.followUpStep, settings.sequence.length - 1);
  const { message, usedAI } = await generateMessage(p, settings, step);
  res.json({ message, step, usedAI });
});

app.get("/api/settings", async (_req, res) => {
  const settings = await getSettings();
  res.json({ settings });
});

app.post("/api/settings", async (req, res) => {
  const current = await getSettings();
  const body = (req.body ?? {}) as Partial<Settings>;
  const merged: Settings = { ...current, ...body };
  if (Array.isArray(body.services)) {
    merged.services = body.services.map(String).filter(Boolean);
  }
  if (Array.isArray(body.sequence)) {
    merged.sequence = (body.sequence as { delayDays: number; template: string }[])
      .filter((x) => x && typeof x.template === "string")
      .map((x, i) => ({
        id: `step-${i + 1}`,
        delayDays: Number(x.delayDays) || 0,
        template: x.template,
      }));
  }
  const saved = await saveSettings(merged);
  res.json({ settings: saved });
});

app.use("/api", (_req, res) => sendError(res, 404, "not found"));

app.listen(PORT, () => {
  console.log(`Bearich Outreach API berjalan di http://localhost:${PORT}`);
});