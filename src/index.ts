import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import "dotenv/config";
import {
  PLATFORM_COOKIE,
  checkPassword,
  credentialsConfigured,
  createToken,
  SESSION_TTL_SECONDS,
  verifyToken,
} from "./auth";
import {
  archiveUnverifiedQualified,
  countQualifiedLeads,
  countRawLeads,
  countSearchTargets,
  countWaPending,
  createTransfer,
  deleteAccount,
  deleteNote,
  deleteTask,
  deleteTransaction,
  findQualifiedByPhone,
  getAccount,
  getAccounts,
  getApps,
  getCashflowSettings,
  getCashflowSummary,
  getDailyCount,
  getNote,
  getNotes,
  getNoteTags,
  getQualifiedLead,
  getQualifiedLeads,
  getDueWaPending,
  getRawLeads,
  getSearchTargets,
  getSettings,
  getTask,
  getTasks,
  getTaskStats,
  getTransaction,
  getTransactions,
  insertAccount,
  insertNote,
  insertTask,
  insertTransaction,
  insertWebhookLog,
  saveCashflowSettings,
  saveSettings,
  updateAccount,
  updateNote,
  updateQualifiedLead,
  updateTask,
  updateTransaction,
} from "./db";
import { todayISO, uid } from "./store";
import { AccountType, CashflowSettings, Note, ProspectStatus, Settings, Task } from "./types";
import { seedSearchTargets } from "./seeder/searchTargets";
import { processNextTarget } from "./workers/scraper";
import { startScheduler } from "./workers/scheduler";

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

type AuthedReq = express.Request & {
  cookies?: Record<string, string>;
  auth?: Record<string, unknown>;
};

function sendError(res: express.Response, status: number, message: string) {
  res.status(status).json({ error: message });
}

type AsyncHandler = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => Promise<void>;

function h(fn: AsyncHandler) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

async function requirePlatformAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const token = (req as AuthedReq).cookies?.[PLATFORM_COOKIE];
  const payload = token
    ? await verifyToken(token, process.env.SESSION_SECRET ?? "")
    : null;
  if (!payload) {
    return sendError(res, 401, "Unauthorized");
  }
  (req as AuthedReq).auth = payload;
  next();
}

function setAuthCookie(res: express.Response, name: string, token: string) {
  const secure = process.env.NODE_ENV === "production";
  const sameSite = (process.env.COOKIE_SAMESITE || (secure ? "none" : "lax")) as
    | "lax"
    | "none"
    | "strict";
  res.cookie(name, token, {
    httpOnly: true,
    secure,
    sameSite,
    domain: process.env.COOKIE_DOMAIN || undefined,
    path: "/",
    maxAge: SESSION_TTL_SECONDS * 1000,
  });
}

function clearAuthCookie(res: express.Response, name: string) {
  res.clearCookie(name, {
    domain: process.env.COOKIE_DOMAIN || undefined,
    path: "/",
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

/* ---------- Platform auth ---------- */

app.post("/api/platform/login", async (req, res) => {
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
  const token = await createToken(
    { u: String(username), scope: "platform" },
    process.env.SESSION_SECRET ?? ""
  );
  setAuthCookie(res, PLATFORM_COOKIE, token);
  res.json({ ok: true });
});

app.get("/api/platform/logout", (req, res) => {
  clearAuthCookie(res, PLATFORM_COOKIE);
  res.json({ ok: true });
});

app.get("/api/platform/me", requirePlatformAuth, (req, res) => {
  const payload = (req as AuthedReq).auth ?? {};
  res.json({ username: String(payload.u ?? "admin") });
});

app.get("/api/apps", requirePlatformAuth, async (_req, res) => {
  const apps = await getApps();
  res.json({ apps });
});

/* ---------- Outreach Autopilot ---------- */

const outreach = express.Router();
outreach.use(requirePlatformAuth);

outreach.get("/stats", async (_req, res) => {
  const [qualified, targets, rawCount, settings] = await Promise.all([
    countQualifiedLeads(),
    countSearchTargets(),
    countRawLeads(),
    getSettings(),
  ]);
  const daily = await getDailyCount(new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" })).toISOString().slice(0,10));
  const envKey = process.env.DEEPSEEK_API_KEY?.trim();
  const deepseekMode = settings.provider === "deepseek" && Boolean(envKey || settings.apiKey) ? "deepseek" : "spintax";
  res.json({ metrics: { qualified, targets, rawLeads: rawCount, dailySent: daily, deepseekMode } });
});

outreach.get("/queue", async (_req, res) => {
  // Monitor: New Lead waiting
  const leads = await getQualifiedLeads({ status: "New Lead", limit: 50 });
  res.json({ due: leads });
});

outreach.get("/leads", async (req, res) => {
  const status = String(req.query.status ?? "");
  // Semua qualified dijamin wa_verified=1 (lihat scraper gate + guard insert).
  const leads = await getQualifiedLeads({ status: status || undefined, limit: 200 });
  res.json({ leads });
});

outreach.get("/leads/:id", async (req, res) => {
  const l = await getQualifiedLead(req.params.id);
  if (!l) return sendError(res, 404, "not found");
  res.json({ lead: l });
});

outreach.patch("/leads/:id", h(async (req, res) => {
  const cur = await getQualifiedLead(req.params.id);
  if (!cur) return sendError(res, 404, "not found");
  const body = req.body ?? {};
  const allowed = ["name","company","city","category"];
  const patch: Record<string, unknown> = {};
  for (const k of allowed) if (body[k] !== undefined) (patch as Record<string,unknown>)[k] = String(body[k]).trim();
  if (body.status && ["New Lead","Contacted","Replied"].includes(String(body.status))) patch.status = String(body.status);
  const updated = await updateQualifiedLead(req.params.id, patch as never);
  res.json({ lead: updated });
}));

outreach.post("/leads/:id/followup-replied", h(async (req, res) => {
  const cur = await getQualifiedLead(req.params.id);
  if (!cur) return sendError(res, 404, "not found");
  if (cur.status !== "Replied") return sendError(res, 400, "hanya untuk status Replied");
  const repliedAt = cur.repliedAt ? new Date(cur.repliedAt) : null;
  if (repliedAt) {
    const diffDays = (Date.now() - repliedAt.getTime()) / (1000*60*60*24);
    if (diffDays < 3) return sendError(res, 400, "follow-up hanya setelah 3 hari dari replied");
  }
  const settings = await getSettings();
  const { sendWA } = await import("./services/waVerify");
  const text = String(req.body?.message ?? cur.message ?? `Halo ${cur.name}, follow-up setelah balasan terakhir.`);
  const dry = String(process.env.AUTOPILOT_DRY_RUN || "true").toLowerCase() === "true";
  if (!dry) {
    const ok = await sendWA(cur.phone628, text);
    if (!ok) return sendError(res, 500, "gagal kirim WA");
  }
  await insertWebhookLog(cur.phone628, "followup_replied", { leadId: cur.id });
  res.json({ ok: true, dry });
}));

outreach.get("/targets", async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const targets = await getSearchTargets({ status, limit: 200 });
  const counts = await countSearchTargets();
  res.json({ targets, counts });
});

outreach.get("/raw-leads", async (req, res) => {
  const city = typeof req.query.city === "string" ? req.query.city : undefined;
  const category = typeof req.query.category === "string" ? req.query.category : undefined;
  const leads = await getRawLeads({ city, category, limit: 100 });
  res.json({ rawLeads: leads });
});

outreach.get("/scheduler/status", async (_req, res) => {
  const nowWIB = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
  const todayStr = nowWIB.toISOString().slice(0,10);
  const daily = await getDailyCount(todayStr);
  const wibHour = nowWIB.getHours();
  const isWeekday = nowWIB.getDay() !== 0 && nowWIB.getDay() !== 6;
  const operational = isWeekday && wibHour >= 9 && wibHour < 16;
  const settings = await getSettings();
  const envKey = process.env.DEEPSEEK_API_KEY?.trim();
  const deepseekMode = settings.provider === "deepseek" && Boolean(envKey || settings.apiKey) ? "deepseek" : "spintax";
  res.json({
    dryRun: String(process.env.AUTOPILOT_DRY_RUN || "true").toLowerCase() === "true",
    dailySent: daily,
    dailyLimit: 10,
    operational,
    wibTime: nowWIB.toISOString(),
    isWeekday,
    deepseekMode,
  });
});

// Admin: seeding & scrape trigger
outreach.post("/admin/seed", h(async (_req, res) => {
  const result = await seedSearchTargets();
  res.json(result);
}));
outreach.post("/admin/scrape-next", h(async (_req, res) => {
  const result = await processNextTarget();
  res.json(result);
}));
// Arsip satu-kali: qualified lama wa_verified=0 -> pending retry (tidak dihapus permanen tanpa jejak)
outreach.post("/admin/archive-unverified", h(async (_req, res) => {
  const result = await archiveUnverifiedQualified();
  res.json(result);
}));
outreach.get("/wa-pending", h(async (_req, res) => {
  const [pending, count] = await Promise.all([getDueWaPending(100), countWaPending()]);
  res.json({ pending, count });
}));
// Verifikasi ulang manual untuk antrian tunda (gateway pernah error)
outreach.post("/wa-pending/reverify", h(async (_req, res) => {
  const { verifyWA } = await import("./services/waVerify");
  const { deleteWaPending } = await import("./db");
  const due = await getDueWaPending(50);
  let verified = 0, inactive = 0, stillPending = 0;
  for (const p of due) {
    const s = await verifyWA(p.phone_628);
    if (s === true) { await deleteWaPending(p.place_id); verified++; }
    else if (s === false) { await deleteWaPending(p.place_id); inactive++; }
    else stillPending++;
  }
  res.json({ checked: due.length, verified, inactive, stillPending });
}));

outreach.get("/settings", async (_req, res) => {
  const settings = await getSettings();
  // mask apiKey if from .env is set (secure), but respect toggle provider
  if (process.env.DEEPSEEK_API_KEY?.trim()) {
    settings.apiKey = "";
  }
  res.json({ settings });
});

outreach.post("/settings", async (req, res) => {
  const current = await getSettings();
  const body = (req.body ?? {}) as Partial<Settings>;
  const merged: Settings = { ...current, ...body };
  if (process.env.DEEPSEEK_API_KEY?.trim()) {
    merged.apiKey = "";
    // provider toggle tetap dihormati (none/spintax vs deepseek)
    if (process.env.DEEPSEEK_BASE_URL) merged.baseUrl = process.env.DEEPSEEK_BASE_URL;
    if (process.env.DEEPSEEK_MODEL) merged.model = process.env.DEEPSEEK_MODEL;
  }
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
  if (process.env.DEEPSEEK_API_KEY?.trim()) {
    saved.apiKey = "";
    saved.provider = "deepseek";
  }
  res.json({ settings: saved });
});

app.use("/api/apps/outreach", outreach);

// Webhook 24/7 (no platform auth, secret check)
app.post("/api/webhooks/wa", async (req, res) => {
  const secret = process.env.WA_WEBHOOK_SECRET;
  if (secret) {
    const hdr = String(req.headers["x-api-key"] ?? req.headers["x-webhook-secret"] ?? "");
    if (hdr !== secret) {
      // allow Evolution without secret if not set, but if set must match
      const isEvolution = req.headers["apikey"] !== undefined;
      if (!isEvolution) return sendError(res, 401, "invalid webhook secret");
    }
  }
  const body = req.body ?? {};
  // Evolution payload variants
  const phoneRaw = body.phone || body.number || body?.data?.key?.remoteJid || body?.data?.pushName || "";
  let phoneDigits = String(phoneRaw).replace(/[^0-9]/g, "");
  if (phoneDigits.startsWith("0")) phoneDigits = "62" + phoneDigits.slice(1);
  if (phoneDigits.startsWith("8")) phoneDigits = "62" + phoneDigits;
  // try extract from remoteJid like 628xxx@s.whatsapp.net
  const jid = String(body?.data?.key?.remoteJid ?? "");
  if (jid.includes("@")) {
    const p = jid.split("@")[0].replace(/[^0-9]/g, "");
    if (p) phoneDigits = p;
  }
  const messageText = body.message || body.text || body?.data?.message?.conversation || body?.data?.message?.extendedTextMessage?.text || "";
  if (!phoneDigits) return res.json({ ok: true });
  const qualified = await findQualifiedByPhone(phoneDigits);
  if (qualified && qualified.status === "Contacted") {
    await updateQualifiedLead(qualified.id, { status: "Replied", repliedAt: new Date().toISOString() } as never);
    await insertWebhookLog(phoneDigits, "replied", body);
  } else {
    await insertWebhookLog(phoneDigits, "unmatched", body);
  }
  res.json({ ok: true });
});

/* ---------- Cash Flow app ---------- */

const cashflow = express.Router();
cashflow.use(requirePlatformAuth);

function parseMonth(value: unknown): string | undefined {
  const m = String(value ?? "");
  return /^\d{4}-\d{2}$/.test(m) ? m : undefined;
}

function parseDate(value: unknown): string | undefined {
  const d = String(value ?? "");
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : undefined;
}

async function accountNameExists(name: string): Promise<boolean> {
  const accounts = await getAccounts();
  return accounts.some((a) => a.name === name);
}

const VALID_ACCOUNT_TYPES: AccountType[] = [
  "tunai",
  "ewallet",
  "rekening",
  "lainnya",
];

cashflow.get("/summary", h(async (req, res) => {
  const summary = await getCashflowSummary({
    month: parseMonth(req.query.month),
    date: parseDate(req.query.date),
    startDate: parseDate(req.query.startDate),
    endDate: parseDate(req.query.endDate),
  });
  res.json({ summary });
}));

cashflow.get("/settings", h(async (_req, res) => {
  const [settings, summary] = await Promise.all([
    getCashflowSettings(),
    getCashflowSummary({}),
  ]);
  res.json({ settings, balance: summary.balance });
}));

cashflow.post("/settings", h(async (req, res) => {
  const body = req.body ?? {};
  const amount = Number(body.targetAmount);
  if (!Number.isFinite(amount) || amount < 0) {
    return sendError(res, 400, "targetAmount harus angka >= 0");
  }
  const settings: CashflowSettings = {
    targetAmount: amount,
    targetType: "saving",
  };
  const saved = await saveCashflowSettings(settings);
  res.json({ settings: saved });
}));

cashflow.get("/accounts", h(async (_req, res) => {
  const accounts = await getAccounts();
  res.json({ accounts });
}));

cashflow.post("/accounts", h(async (req, res) => {
  const body = req.body ?? {};
  const name = String(body.name ?? "").trim();
  if (!name) return sendError(res, 400, "name wajib diisi");
  if (await accountNameExists(name)) {
    return sendError(res, 400, "Nama akun sudah ada");
  }
  const type = VALID_ACCOUNT_TYPES.includes(body.type as AccountType)
    ? (body.type as AccountType)
    : "lainnya";
  const account = {
    id: uid("acc_"),
    name,
    type,
    createdAt: todayISO(),
  };
  await insertAccount(account);
  res.status(201).json({ account });
}));

cashflow.patch("/accounts/:id", h(async (req, res) => {
  const current = await getAccount(req.params.id);
  if (!current) return sendError(res, 404, "not found");
  const body = req.body ?? {};
  const patch: Partial<typeof current> = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return sendError(res, 400, "name wajib diisi");
    if (name !== current.name && (await accountNameExists(name))) {
      return sendError(res, 400, "Nama akun sudah ada");
    }
    patch.name = name;
  }
  if (VALID_ACCOUNT_TYPES.includes(body.type as AccountType)) {
    patch.type = body.type as AccountType;
  }
  const updated = await updateAccount(req.params.id, patch);
  res.json({ account: updated });
}));

cashflow.delete("/accounts/:id", h(async (req, res) => {
  const result = await deleteAccount(req.params.id);
  if (!result.removed && result.inUse) {
    return sendError(
      res,
      400,
      "Akun masih dipakai transaksi. Pindahkan transaksi ke akun lain dulu."
    );
  }
  if (!result.removed) return sendError(res, 404, "not found");
  res.json({ removed: true });
}));

cashflow.post("/transfer", h(async (req, res) => {
  const body = req.body ?? {};
  const from = String(body.from ?? "").trim();
  const to = String(body.to ?? "").trim();
  if (!from || !to) return sendError(res, 400, "from dan to wajib diisi");
  if (from === to) return sendError(res, 400, "Akun asal dan tujuan tidak boleh sama");
  if (!(await accountNameExists(from)) || !(await accountNameExists(to))) {
    return sendError(res, 400, "Akun tidak ditemukan");
  }
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return sendError(res, 400, "amount harus angka positif");
  }
  const date = String(body.date ?? "").slice(0, 10);
  const transfer = await createTransfer({
    from,
    to,
    amount,
    date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined,
  });
  res.status(201).json({ transfer });
}));

cashflow.get("/transactions", h(async (req, res) => {
  const transactions = await getTransactions({
    month: parseMonth(req.query.month),
    date: parseDate(req.query.date),
    startDate: parseDate(req.query.startDate),
    endDate: parseDate(req.query.endDate),
    type: typeof req.query.type === "string" ? req.query.type : undefined,
    category:
      typeof req.query.category === "string" ? req.query.category : undefined,
    account:
      typeof req.query.account === "string" ? req.query.account : undefined,
  });
  res.json({ transactions });
}));

cashflow.post("/transactions", h(async (req, res) => {
  const body = req.body ?? {};
  const type = String(body.type ?? "");
  if (type !== "in" && type !== "out") {
    return sendError(res, 400, "type harus 'in' atau 'out'");
  }
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return sendError(res, 400, "amount harus angka positif");
  }
  const category = String(body.category ?? "Lainnya").trim() || "Lainnya";
  let account = String(body.account ?? "Tunai").trim() || "Tunai";
  if (!(await accountNameExists(account))) {
    account = "Tunai";
  }
  const date = String(body.date ?? "").slice(0, 10);
  const transaction = {
    id: uid("t_"),
    type: type as "in" | "out",
    amount,
    category,
    account,
    description: body.description !== undefined ? String(body.description) : undefined,
    date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : todayISO().slice(0, 10),
    createdAt: todayISO(),
  };
  await insertTransaction(transaction);
  res.status(201).json({ transaction });
}));

cashflow.patch("/transactions/:id", h(async (req, res) => {
  const current = await getTransaction(req.params.id);
  if (!current) return sendError(res, 404, "not found");
  const body = req.body ?? {};
  const patch: Partial<typeof current> = {};
  if (body.type === "in" || body.type === "out") patch.type = body.type;
  if (body.amount !== undefined) {
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return sendError(res, 400, "amount harus angka positif");
    }
    patch.amount = amount;
  }
  if (body.category !== undefined) {
    const category = String(body.category).trim();
    if (category) patch.category = category;
  }
  if (body.account !== undefined) {
    const account = String(body.account).trim();
    if (account && (await accountNameExists(account))) patch.account = account;
  }
  if (body.description !== undefined) patch.description = String(body.description);
  if (body.date !== undefined) {
    const date = String(body.date).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) patch.date = date;
  }
  const updated = await updateTransaction(req.params.id, patch);
  res.json({ transaction: updated });
}));

cashflow.delete("/transactions/:id", h(async (req, res) => {
  const ok = await deleteTransaction(req.params.id);
  if (!ok) return sendError(res, 404, "not found");
  res.json({ removed: true });
}));

app.use("/api/apps/cashflow", cashflow);

/* ---------- Notes app ---------- */

const notes = express.Router();
notes.use(requirePlatformAuth);

notes.get("/tags", h(async (_req, res) => {
  const tags = await getNoteTags();
  res.json({ tags });
}));

notes.get("/notes", h(async (req, res) => {
  const notesList = await getNotes({
    search: typeof req.query.search === "string" ? req.query.search : undefined,
    tag: typeof req.query.tag === "string" ? req.query.tag : undefined,
  });
  res.json({ notes: notesList });
}));

notes.post("/notes", h(async (req, res) => {
  const body = req.body ?? {};
  const title = String(body.title ?? "").trim();
  if (!title) return sendError(res, 400, "title wajib diisi");
  const tags = Array.isArray(body.tags)
    ? body.tags.map(String).filter(Boolean)
    : [];
  const now = todayISO();
  const note: Note = {
    id: uid("n_"),
    title,
    content: body.content !== undefined ? String(body.content) : "",
    tags,
    pinned: Boolean(body.pinned),
    createdAt: now,
    updatedAt: now,
  };
  await insertNote(note);
  res.status(201).json({ note });
}));

notes.get("/notes/:id", h(async (req, res) => {
  const note = await getNote(req.params.id);
  if (!note) return sendError(res, 404, "not found");
  res.json({ note });
}));

notes.patch("/notes/:id", h(async (req, res) => {
  const current = await getNote(req.params.id);
  if (!current) return sendError(res, 404, "not found");
  const body = req.body ?? {};
  const patch: Partial<Note> = {};
  if (body.title !== undefined) {
    const title = String(body.title).trim();
    if (!title) return sendError(res, 400, "title wajib diisi");
    patch.title = title;
  }
  if (body.content !== undefined) patch.content = String(body.content);
  if (body.tags !== undefined) {
    patch.tags = Array.isArray(body.tags) ? body.tags.map(String).filter(Boolean) : [];
  }
  if (body.pinned !== undefined) patch.pinned = Boolean(body.pinned);
  const updated = await updateNote(req.params.id, patch);
  res.json({ note: updated });
}));

notes.delete("/notes/:id", h(async (req, res) => {
  const ok = await deleteNote(req.params.id);
  if (!ok) return sendError(res, 404, "not found");
  res.json({ removed: true });
}));

app.use("/api/apps/notes", notes);

/* ---------- Tasks app ---------- */

const tasks = express.Router();
tasks.use(requirePlatformAuth);

const VALID_TASK_STATUS: Task["status"][] = ["todo", "in_progress", "done"];
const VALID_TASK_PRIORITY: Task["priority"][] = ["low", "medium", "high"];

tasks.get("/stats", h(async (_req, res) => {
  const stats = await getTaskStats();
  res.json({ stats });
}));

tasks.get("/tasks", h(async (req, res) => {
  const taskList = await getTasks({
    status: typeof req.query.status === "string" ? req.query.status : undefined,
    priority: typeof req.query.priority === "string" ? req.query.priority : undefined,
    search: typeof req.query.search === "string" ? req.query.search : undefined,
    dueDate: typeof req.query.dueDate === "string" ? req.query.dueDate : undefined,
  });
  res.json({ tasks: taskList });
}));

tasks.post("/tasks", h(async (req, res) => {
  const body = req.body ?? {};
  const title = String(body.title ?? "").trim();
  if (!title) return sendError(res, 400, "title wajib diisi");
  const status = VALID_TASK_STATUS.includes(body.status as Task["status"])
    ? (body.status as Task["status"])
    : "todo";
  const priority = VALID_TASK_PRIORITY.includes(body.priority as Task["priority"])
    ? (body.priority as Task["priority"])
    : "medium";
  const now = todayISO();
  const due = String(body.dueDate ?? "").slice(0, 10);
  const task: Task = {
    id: uid("tsk_"),
    title,
    description: body.description !== undefined ? String(body.description) : undefined,
    status,
    priority,
    dueDate: /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : undefined,
    createdAt: now,
    updatedAt: now,
    completedAt: status === "done" ? now : undefined,
  };
  await insertTask(task);
  res.status(201).json({ task });
}));

tasks.get("/tasks/:id", h(async (req, res) => {
  const task = await getTask(req.params.id);
  if (!task) return sendError(res, 404, "not found");
  res.json({ task });
}));

tasks.patch("/tasks/:id", h(async (req, res) => {
  const current = await getTask(req.params.id);
  if (!current) return sendError(res, 404, "not found");
  const body = req.body ?? {};
  const patch: Partial<Task> = {};
  if (body.title !== undefined) {
    const title = String(body.title).trim();
    if (!title) return sendError(res, 400, "title wajib diisi");
    patch.title = title;
  }
  if (body.description !== undefined) patch.description = String(body.description);
  if (VALID_TASK_STATUS.includes(body.status as Task["status"])) {
    patch.status = body.status as Task["status"];
  }
  if (VALID_TASK_PRIORITY.includes(body.priority as Task["priority"])) {
    patch.priority = body.priority as Task["priority"];
  }
  if (body.dueDate !== undefined) {
    const due = String(body.dueDate).slice(0, 10);
    patch.dueDate = /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : undefined;
  }
  if (patch.status !== undefined) {
    patch.completedAt = patch.status === "done" ? todayISO() : undefined;
  }
  const updated = await updateTask(req.params.id, patch);
  res.json({ task: updated });
}));

tasks.delete("/tasks/:id", h(async (req, res) => {
  const ok = await deleteTask(req.params.id);
  if (!ok) return sendError(res, 404, "not found");
  res.json({ removed: true });
}));

app.use("/api/apps/tasks", tasks);

app.use("/api", (_req, res) => sendError(res, 404, "not found"));

app.use(
  (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    sendError(res, 500, "Terjadi kesalahan server.");
  }
);

app.listen(PORT, () => {
  console.log(`Bearich Outreach API berjalan di http://localhost:${PORT}`);
  try { startScheduler(); console.log("Scheduler autopilot aktif (dryRun=" + process.env.AUTOPILOT_DRY_RUN + ")"); } catch {}
});