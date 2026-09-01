import {
  createPool,
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import {
  AccountBalance,
  AccountType,
  Activity,
  App,
  CashflowAccount,
  CashflowSettings,
  CashflowSummary,
  Note,
  Prospect,
  ProspectStatus,
  SequenceStep,
  Settings,
  Task,
  TaskPriority,
  TaskStats,
  TaskStatus,
  Transaction,
  TransactionType,
} from "./types";
import { todayISO, uid } from "./store";
import { hashPassword, randomSecret } from "./auth";

const DEFAULTS = {
  businessName: "Bearich Studio",
  services: [
    "Website & landing page",
    "Web dashboard & sistem web",
    "Backend / API & integrasi",
    "Otomasi proses bisnis",
    "Maintenance & perbaikan website",
  ],
  segmentFocus: "",
  provider: "none",
  apiKey: "",
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-chat",
  weeklyTarget: 25,
  sequence: [
    {
      id: "step-1",
      delayDays: 0,
      template:
        "Halo {name}, saya {business}. Saya bantu bisnis seperti {company} mengembangkan website/web serta otomasi proses (produk, booking, dashboard, dll). Apakah ada kebutuhan seperti ini saat ini?",
    },
    {
      id: "step-2",
      delayDays: 3,
      template:
        "Halo {name}, sekadar follow up pesan saya sebelumnya soal pengembangan web & otomasi untuk {company}. Kalau saat ini belum, tidak masalah — saya simpan kontak ini saja.",
    },
    {
      id: "step-3",
      delayDays: 5,
      template:
        "Halo {name}, satu info lagi: saya juga handle maintenance & perbaikan website existing. Kalau {company} ada web yang butuh diperbaiki atau ditingkatkan, kabari saja ya.",
    },
  ],
};

let pool: Pool | null = null;
let schemaReady = false;

function getPool(): Pool {
  if (!pool) {
    pool = createPool({
      host: process.env.DB_HOST || "localhost",
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || "root",
      password: process.env.DB_PASSWORD || "",
      database: process.env.DB_NAME || "bearich",
      waitForConnections: true,
      connectionLimit: 10,
      dateStrings: true,
      charset: "utf8mb4",
    });
  }
  return pool;
}

export function toMysql(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 23).replace("T", " ");
}

export function fromMysql(dt?: string | Date | null): string | undefined {
  if (!dt) return undefined;
  if (dt instanceof Date) return dt.toISOString();
  const str = String(dt).trim();
  if (!str) return undefined;
  const isoStr = str.endsWith("Z")
    ? str
    : str.includes("T")
    ? str + "Z"
    : str.replace(" ", "T") + "Z";
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

interface SettingsRow extends RowDataPacket {
  business_name: string;
  services: string | unknown;
  segment_focus: string;
  provider: string;
  api_key: string;
  base_url: string;
  model: string;
  weekly_target: number;
  sequence: string | unknown;
}

function rowToSettings(row: SettingsRow): Settings {
  return {
    businessName: row.business_name,
    services: parseJson<string[]>(row.services, DEFAULTS.services),
    segmentFocus: row.segment_focus,
    provider: row.provider,
    apiKey: row.api_key,
    baseUrl: row.base_url,
    model: row.model,
    weeklyTarget: row.weekly_target,
    sequence: parseJson<SequenceStep[]>(row.sequence, DEFAULTS.sequence),
  };
}

interface ProspectRow extends RowDataPacket {
  id: string;
  name: string;
  company: string;
  channel: string;
  contact: string;
  segment: string;
  notes: string;
  status: ProspectStatus;
  created_at: string;
  last_contact_at: string | null;
  next_follow_up_at: string | null;
  follow_up_step: number;
  closed_at: string | null;
  closed_value: number | null;
}

function rowToProspect(row: ProspectRow): Prospect {
  return {
    id: row.id,
    name: row.name,
    company: row.company,
    channel: row.channel,
    contact: row.contact,
    segment: row.segment,
    notes: row.notes,
    status: row.status,
    createdAt: fromMysql(row.created_at) ?? todayISO(),
    lastContactAt: fromMysql(row.last_contact_at),
    nextFollowUpAt: fromMysql(row.next_follow_up_at),
    followUpStep: row.follow_up_step,
    closedAt: fromMysql(row.closed_at),
    closedValue: row.closed_value == null ? undefined : Number(row.closed_value),
  };
}

interface ActivityRow extends RowDataPacket {
  id: string;
  prospect_id: string;
  type: Activity["type"];
  message: string | null;
  created_at: string;
}

function rowToActivity(row: ActivityRow): Activity {
  return {
    id: row.id,
    prospectId: row.prospect_id,
    type: row.type,
    message: row.message ?? "",
    createdAt: fromMysql(row.created_at) ?? todayISO(),
  };
}

export async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  const conn = await getPool().getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS settings (
        id INT PRIMARY KEY DEFAULT 1,
        business_name VARCHAR(255) NOT NULL DEFAULT '${DEFAULTS.businessName}',
        services JSON NOT NULL,
        segment_focus VARCHAR(255) NOT NULL DEFAULT '',
        provider VARCHAR(50) NOT NULL DEFAULT 'none',
        api_key VARCHAR(500) NOT NULL DEFAULT '',
        base_url VARCHAR(255) NOT NULL DEFAULT '${DEFAULTS.baseUrl}',
        model VARCHAR(100) NOT NULL DEFAULT '${DEFAULTS.model}',
        weekly_target INT NOT NULL DEFAULT 25,
        sequence JSON NOT NULL,
        CHECK (id = 1)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS prospects (
        id VARCHAR(40) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        company VARCHAR(255) NOT NULL DEFAULT '',
        channel VARCHAR(50) NOT NULL DEFAULT 'linkedin',
        contact VARCHAR(255) NOT NULL DEFAULT '',
        segment VARCHAR(255) NOT NULL DEFAULT '',
        notes TEXT,
        status VARCHAR(20) NOT NULL DEFAULT 'new',
        created_at DATETIME(3) NOT NULL,
        last_contact_at DATETIME(3) NULL,
        next_follow_up_at DATETIME(3) NULL,
        follow_up_step INT NOT NULL DEFAULT 0,
        closed_at DATETIME(3) NULL,
        closed_value DECIMAL(12,2) NULL DEFAULT 0,
        INDEX idx_status (status),
        INDEX idx_follow_up (next_follow_up_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS activities (
        id VARCHAR(40) PRIMARY KEY,
        prospect_id VARCHAR(40) NOT NULL,
        type VARCHAR(20) NOT NULL,
        message TEXT,
        created_at DATETIME(3) NOT NULL,
        INDEX idx_prospect (prospect_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS apps (
        id VARCHAR(40) PRIMARY KEY,
        slug VARCHAR(50) NOT NULL UNIQUE,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        icon VARCHAR(50) NOT NULL DEFAULT '',
        enabled TINYINT(1) NOT NULL DEFAULT 1,
        session_secret VARCHAR(128) NOT NULL,
        created_at DATETIME(3) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS app_credentials (
        id VARCHAR(40) PRIMARY KEY,
        app_id VARCHAR(40) NOT NULL,
        username VARCHAR(100) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at DATETIME(3) NOT NULL,
        UNIQUE KEY uq_app_user (app_id, username),
        INDEX idx_app_id (app_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id VARCHAR(40) PRIMARY KEY,
        type VARCHAR(10) NOT NULL,
        amount DECIMAL(12,2) NOT NULL,
        category VARCHAR(100) NOT NULL DEFAULT '',
        account VARCHAR(50) NOT NULL DEFAULT 'Tunai',
        description TEXT,
        txn_date DATE NOT NULL,
        created_at DATETIME(3) NOT NULL,
        INDEX idx_type (type),
        INDEX idx_date (txn_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS cashflow_accounts (
        id VARCHAR(40) PRIMARY KEY,
        name VARCHAR(50) NOT NULL UNIQUE,
        type VARCHAR(20) NOT NULL DEFAULT 'lainnya',
        created_at DATETIME(3) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS notes (
        id VARCHAR(40) PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        content TEXT,
        tags JSON NOT NULL,
        pinned TINYINT(1) NOT NULL DEFAULT 0,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        INDEX idx_pinned (pinned)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS cashflow_settings (
        id INT PRIMARY KEY DEFAULT 1,
        target_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
        target_type VARCHAR(20) NOT NULL DEFAULT 'saving',
        CHECK (id = 1)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(
      "INSERT IGNORE INTO cashflow_settings (id, target_amount, target_type) VALUES (1, 0, 'saving')"
    );
    await conn.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id VARCHAR(40) PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        status VARCHAR(20) NOT NULL DEFAULT 'todo',
        priority VARCHAR(10) NOT NULL DEFAULT 'medium',
        due_date DATE NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        completed_at DATETIME(3) NULL,
        INDEX idx_status (status),
        INDEX idx_due (due_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    const [existing] = await conn.query<RowDataPacket[]>(
      "SELECT id FROM settings WHERE id = 1"
    );
    if (existing.length === 0) {
      await conn.query(
        "INSERT IGNORE INTO settings (id, services, sequence) VALUES (1, ?, ?)",
        [JSON.stringify(DEFAULTS.services), JSON.stringify(DEFAULTS.sequence)]
      );
    }

    const DEFAULT_APPS: { slug: string; name: string; description: string }[] =
      [
        {
          slug: "outreach",
          name: "Outreach",
          description: "Pipeline & otomasi outreach",
        },
        {
          slug: "tasks",
          name: "Task Management",
          description: "Kelola tugas harian",
        },
        { slug: "notes", name: "Notes", description: "Catatan & dokumentasi" },
        {
          slug: "cashflow",
          name: "Cash Flow",
          description: "Catat uang masuk & keluar",
        },
      ];
    for (const a of DEFAULT_APPS) {
      const [rows] = await conn.query<RowDataPacket[]>(
        "SELECT id FROM apps WHERE slug = ?",
        [a.slug]
      );
      if (rows.length === 0) {
        await conn.query(
          `INSERT INTO apps (id, slug, name, description, icon, enabled, session_secret, created_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
          [
            uid("app_"),
            a.slug,
            a.name,
            a.description,
            a.slug,
            randomSecret(),
            toMysql(todayISO()),
          ]
        );
      }
    }

    const adminUser = process.env.ADMIN_USERNAME;
    const adminPass = process.env.ADMIN_PASSWORD;
    if (adminUser && adminPass) {
      const [appRows] = await conn.query<RowDataPacket[]>("SELECT id FROM apps");
      for (const row of appRows) {
        const appId = String(row.id);
        const [credRows] = await conn.query<RowDataPacket[]>(
          "SELECT id FROM app_credentials WHERE app_id = ?",
          [appId]
        );
        if (credRows.length === 0) {
          await conn.query(
            `INSERT INTO app_credentials (id, app_id, username, password_hash, created_at)
             VALUES (?, ?, ?, ?, ?)`,
            [
              uid("c_"),
              appId,
              adminUser,
              hashPassword(adminPass),
              toMysql(todayISO()),
            ]
          );
        }
      }
    }

    try {
      await conn.query(
        "ALTER TABLE transactions ADD COLUMN account VARCHAR(50) NOT NULL DEFAULT 'Tunai' AFTER category"
      );
    } catch {
      // kolom sudah ada (tabel lama) — abaikan
    }

    const DEFAULT_ACCOUNTS: { name: string; type: AccountType }[] = [
      { name: "Tunai", type: "tunai" },
      { name: "E-Wallet", type: "ewallet" },
      { name: "Rekening", type: "rekening" },
    ];
    for (const a of DEFAULT_ACCOUNTS) {
      const [rows] = await conn.query<RowDataPacket[]>(
        "SELECT id FROM cashflow_accounts WHERE name = ?",
        [a.name]
      );
      if (rows.length === 0) {
        await conn.query(
          "INSERT INTO cashflow_accounts (id, name, type, created_at) VALUES (?, ?, ?, ?)",
          [uid("acc_"), a.name, a.type, toMysql(todayISO())]
        );
      }
    }
  } finally {
    conn.release();
  }
  schemaReady = true;
}

async function getConn(): Promise<PoolConnection> {
  await ensureSchema();
  return getPool().getConnection();
}

export async function getSettings(): Promise<Settings> {
  const conn = await getConn();
  try {
    const [rows] = await conn.query<SettingsRow[]>(
      "SELECT * FROM settings WHERE id = 1"
    );
    return rows.length ? rowToSettings(rows[0]) : DEFAULTS;
  } finally {
    conn.release();
  }
}

export async function saveSettings(s: Settings): Promise<Settings> {
  const conn = await getConn();
  try {
    await conn.query(
      `INSERT INTO settings (id, business_name, services, segment_focus, provider, api_key, base_url, model, weekly_target, sequence)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         business_name = VALUES(business_name),
         services = VALUES(services),
         segment_focus = VALUES(segment_focus),
         provider = VALUES(provider),
         api_key = VALUES(api_key),
         base_url = VALUES(base_url),
         model = VALUES(model),
         weekly_target = VALUES(weekly_target),
         sequence = VALUES(sequence)`,
      [
        s.businessName,
        JSON.stringify(s.services),
        s.segmentFocus,
        s.provider,
        s.apiKey,
        s.baseUrl,
        s.model,
        s.weeklyTarget,
        JSON.stringify(s.sequence),
      ]
    );
    return s;
  } finally {
    conn.release();
  }
}

export async function getProspects(): Promise<Prospect[]> {
  const conn = await getConn();
  try {
    const [rows] = await conn.query<ProspectRow[]>(
      "SELECT * FROM prospects ORDER BY created_at DESC"
    );
    return rows.map(rowToProspect);
  } finally {
    conn.release();
  }
}

export async function getProspect(id: string): Promise<Prospect | undefined> {
  const conn = await getConn();
  try {
    const [rows] = await conn.query<ProspectRow[]>(
      "SELECT * FROM prospects WHERE id = ?",
      [id]
    );
    return rows.length ? rowToProspect(rows[0]) : undefined;
  } finally {
    conn.release();
  }
}

export async function insertProspect(p: Prospect): Promise<Prospect> {
  const conn = await getConn();
  try {
    await conn.query(
      `INSERT INTO prospects
        (id, name, company, channel, contact, segment, notes, status, created_at, last_contact_at, next_follow_up_at, follow_up_step, closed_at, closed_value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        p.id,
        p.name,
        p.company ?? "",
        p.channel,
        p.contact ?? "",
        p.segment ?? "",
        p.notes ?? "",
        p.status,
        toMysql(p.createdAt),
        toMysql(p.lastContactAt),
        toMysql(p.nextFollowUpAt),
        p.followUpStep,
        toMysql(p.closedAt),
        p.closedValue ?? 0,
      ]
    );
    return p;
  } finally {
    conn.release();
  }
}

export async function updateProspect(
  id: string,
  patch: Partial<Prospect>
): Promise<Prospect | undefined> {
  const conn = await getConn();
  try {
    const current = await getProspect(id);
    if (!current) return undefined;
    const merged = { ...current, ...patch };
    await conn.query(
      `UPDATE prospects SET
        name = ?, company = ?, channel = ?, contact = ?, segment = ?, notes = ?,
        status = ?, last_contact_at = ?, next_follow_up_at = ?, follow_up_step = ?,
        closed_at = ?, closed_value = ?
       WHERE id = ?`,
      [
        merged.name,
        merged.company ?? "",
        merged.channel,
        merged.contact ?? "",
        merged.segment ?? "",
        merged.notes ?? "",
        merged.status,
        toMysql(merged.lastContactAt),
        toMysql(merged.nextFollowUpAt),
        merged.followUpStep,
        toMysql(merged.closedAt),
        merged.closedValue ?? 0,
        id,
      ]
    );
    return merged;
  } finally {
    conn.release();
  }
}

export async function deleteProspect(id: string): Promise<boolean> {
  const conn = await getConn();
  try {
    const [res] = await conn.query<ResultSetHeader>(
      "DELETE FROM prospects WHERE id = ?",
      [id]
    );
    await conn.query("DELETE FROM activities WHERE prospect_id = ?", [id]);
    return res.affectedRows > 0;
  } finally {
    conn.release();
  }
}

export async function addActivity(
  prospectId: string,
  type: Activity["type"],
  message?: string
): Promise<void> {
  const conn = await getConn();
  try {
    await conn.query(
      "INSERT INTO activities (id, prospect_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)",
      [uid("a_"), prospectId, type, message ?? "", toMysql(todayISO())]
    );
  } finally {
    conn.release();
  }
}

export async function getActivities(prospectId: string): Promise<Activity[]> {
  const conn = await getConn();
  try {
    const [rows] = await conn.query<ActivityRow[]>(
      "SELECT * FROM activities WHERE prospect_id = ? ORDER BY created_at DESC",
      [prospectId]
    );
    return rows.map(rowToActivity);
  } finally {
    conn.release();
  }
}

export async function getDue(now = new Date()): Promise<Prospect[]> {
  const conn = await getConn();
  try {
    const cutoff = toMysql(now.toISOString());
    const [rows] = await conn.query<ProspectRow[]>(
      `SELECT * FROM prospects
       WHERE status IN ('new','contacted')
         AND next_follow_up_at IS NOT NULL
         AND next_follow_up_at <= ?
       ORDER BY next_follow_up_at ASC`,
      [cutoff]
    );
    return rows.map(rowToProspect);
  } finally {
    conn.release();
  }
}

export async function getMetrics(now = new Date()) {
  const conn = await getConn();
  try {
    const cutoff = toMysql(now.toISOString());
    const [statusRows] = await conn.query<RowDataPacket[]>(
      "SELECT status, COUNT(*) AS cnt FROM prospects GROUP BY status"
    );
    const [totalRow] = await conn.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS total FROM prospects"
    );
    const [revRow] = await conn.query<RowDataPacket[]>(
      "SELECT COALESCE(SUM(closed_value),0) AS revenue FROM prospects"
    );
    const [dueRow] = await conn.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS due FROM prospects
       WHERE status IN ('new','contacted')
         AND next_follow_up_at IS NOT NULL
         AND next_follow_up_at <= ?`,
      [cutoff]
    );

    const byStatus: Record<string, number> = {};
    statusRows.forEach((r) => {
      byStatus[String(r.status)] = Number(r.cnt);
    });

    const total = Number(totalRow[0]?.total ?? 0);
    const closed = byStatus.closed ?? 0;
    const interested = (byStatus.interested ?? 0) + closed;
    const replied =
      (byStatus.replied ?? 0) + (byStatus.interested ?? 0) + closed;

return {
        total,
        byStatus,
        replied,
        interested,
        closed,
        dead: byStatus.dead ?? 0,
        due: Number(dueRow[0]?.due ?? 0),
        replyRate: total > 0 ? Math.round((replied / total) * 100) : 0,
        closeRate: total > 0 ? Math.round((closed / total) * 100) : 0,
        revenue: Number(revRow[0]?.revenue ?? 0),
      };
    } finally {
    conn.release();
  }
}

interface AppRow extends RowDataPacket {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  icon: string;
  enabled: number;
  created_at: string;
}

function rowToApp(row: AppRow): App {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description ?? undefined,
    icon: row.icon,
    enabled: Boolean(row.enabled),
    createdAt: fromMysql(row.created_at) ?? todayISO(),
  };
}

export async function getApps(): Promise<App[]> {
  const conn = await getConn();
  try {
    const [rows] = await conn.query<AppRow[]>(
      "SELECT * FROM apps WHERE enabled = 1 ORDER BY created_at ASC"
    );
    return rows.map(rowToApp);
  } finally {
    conn.release();
  }
}

export async function getAppBySlug(slug: string): Promise<App | undefined> {
  const conn = await getConn();
  try {
    const [rows] = await conn.query<AppRow[]>(
      "SELECT * FROM apps WHERE slug = ?",
      [slug]
    );
    return rows.length ? rowToApp(rows[0]) : undefined;
  } finally {
    conn.release();
  }
}

export async function getAppSessionSecret(
  slug: string
): Promise<string | undefined> {
  const conn = await getConn();
  try {
    const [rows] = await conn.query<RowDataPacket[]>(
      "SELECT session_secret FROM apps WHERE slug = ?",
      [slug]
    );
    return rows.length ? String(rows[0].session_secret) : undefined;
  } finally {
    conn.release();
  }
}

interface AppCredentialRow extends RowDataPacket {
  id: string;
  app_id: string;
  username: string;
  password_hash: string;
}

export async function getAppCredentials(
  appId: string,
  username: string
): Promise<{ passwordHash: string } | undefined> {
  const conn = await getConn();
  try {
    const [rows] = await conn.query<AppCredentialRow[]>(
      "SELECT * FROM app_credentials WHERE app_id = ? AND username = ?",
      [appId, username]
    );
    return rows.length ? { passwordHash: rows[0].password_hash } : undefined;
  } finally {
    conn.release();
  }
}

/* ---------- Cash Flow ---------- */

interface TransactionRow extends RowDataPacket {
  id: string;
  type: TransactionType;
  amount: string | number;
  category: string;
  account: string;
  description: string | null;
  txn_date: string;
  created_at: string;
}

function rowToTransaction(row: TransactionRow): Transaction {
  return {
    id: row.id,
    type: row.type,
    amount: Number(row.amount),
    category: row.category,
    account: row.account ?? "Tunai",
    description: row.description ?? undefined,
    date: String(row.txn_date),
    createdAt: fromMysql(row.created_at) ?? todayISO(),
  };
}

function txnDateToSql(date?: string): string | null {
  if (!date) return null;
  const m = String(date).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function monthRange(
  month: string
): { start: string; end: string } | null {
  const m = String(month).match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  const ny = mo === 12 ? y + 1 : y;
  const nm = mo === 12 ? 1 : mo + 1;
  return {
    start: `${m[1]}-${m[2]}-01`,
    end: `${ny}-${String(nm).padStart(2, "0")}-01`,
  };
}

export async function getTransactions(opts: {
  month?: string;
  type?: string;
  category?: string;
  account?: string;
} = {}): Promise<Transaction[]> {
  const conn = await getConn();
  try {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.month) {
      const range = monthRange(opts.month);
      if (range) {
        where.push("txn_date >= ? AND txn_date < ?");
        params.push(range.start, range.end);
      }
    }
    if (opts.type === "in" || opts.type === "out") {
      where.push("type = ?");
      params.push(opts.type);
    }
    if (opts.category) {
      where.push("category = ?");
      params.push(opts.category);
    }
    if (opts.account) {
      where.push("account = ?");
      params.push(opts.account);
    }
    const sql =
      "SELECT * FROM transactions" +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY txn_date DESC, created_at DESC";
    const [rows] = await conn.query<TransactionRow[]>(sql, params);
    return rows.map(rowToTransaction);
  } finally {
    conn.release();
  }
}

export async function getTransaction(
  id: string
): Promise<Transaction | undefined> {
  const conn = await getConn();
  try {
    const [rows] = await conn.query<TransactionRow[]>(
      "SELECT * FROM transactions WHERE id = ?",
      [id]
    );
    return rows.length ? rowToTransaction(rows[0]) : undefined;
  } finally {
    conn.release();
  }
}

export async function insertTransaction(t: Transaction): Promise<Transaction> {
  const conn = await getConn();
  try {
    await conn.query(
      `INSERT INTO transactions (id, type, amount, category, account, description, txn_date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        t.id,
        t.type,
        t.amount,
        t.category,
        t.account ?? "Tunai",
        t.description ?? "",
        txnDateToSql(t.date) ?? toMysql(todayISO()),
        toMysql(t.createdAt),
      ]
    );
    return t;
  } finally {
    conn.release();
  }
}

export async function updateTransaction(
  id: string,
  patch: Partial<Transaction>
): Promise<Transaction | undefined> {
  const conn = await getConn();
  try {
    const current = await getTransaction(id);
    if (!current) return undefined;
    const merged = { ...current, ...patch };
    await conn.query(
      `UPDATE transactions SET
        type = ?, amount = ?, category = ?, account = ?, description = ?, txn_date = ?
       WHERE id = ?`,
      [
        merged.type,
        merged.amount,
        merged.category,
        merged.account ?? "Tunai",
        merged.description ?? "",
        txnDateToSql(merged.date) ?? toMysql(todayISO()),
        id,
      ]
    );
    return merged;
  } finally {
    conn.release();
  }
}

export async function deleteTransaction(id: string): Promise<boolean> {
  const conn = await getConn();
  try {
    const [res] = await conn.query<ResultSetHeader>(
      "DELETE FROM transactions WHERE id = ?",
      [id]
    );
    return res.affectedRows > 0;
  } finally {
    conn.release();
  }
}

export async function getCashflowSummary(
  opts: { month?: string } = {}
): Promise<CashflowSummary> {
  const conn = await getConn();
  try {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.month) {
      const range = monthRange(opts.month);
      if (range) {
        where.push("txn_date >= ? AND txn_date < ?");
        params.push(range.start, range.end);
      }
    }
    const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";

    const [sumRows] = await conn.query<RowDataPacket[]>(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'in' THEN amount ELSE 0 END), 0) AS total_in,
         COALESCE(SUM(CASE WHEN type = 'out' THEN amount ELSE 0 END), 0) AS total_out,
         COALESCE(SUM(CASE WHEN type = 'in' THEN 1 ELSE 0 END), 0) AS count_in,
         COALESCE(SUM(CASE WHEN type = 'out' THEN 1 ELSE 0 END), 0) AS count_out
       FROM transactions${whereSql}`,
      params
    );
    const r = sumRows[0] ?? {};
    const totalIn = Number(r.total_in ?? 0);
    const totalOut = Number(r.total_out ?? 0);

    const [catRows] = await conn.query<RowDataPacket[]>(
      `SELECT category, COALESCE(SUM(amount), 0) AS amount
       FROM transactions${whereSql}
       GROUP BY category ORDER BY amount DESC`,
      params
    );
    const byCategory: Record<string, number> = {};
    catRows.forEach((row) => {
      byCategory[String(row.category)] = Number(row.amount);
    });

    const [accRows] = await conn.query<RowDataPacket[]>(
      `SELECT account,
              COALESCE(SUM(CASE WHEN type = 'in' THEN amount ELSE -amount END), 0) AS balance
       FROM transactions${whereSql}
       GROUP BY account ORDER BY balance DESC`,
      params
    );
    const perAccount: AccountBalance[] = accRows.map((row) => ({
      account: String(row.account),
      balance: Number(row.balance),
    }));

    return {
      totalIn,
      totalOut,
      balance: totalIn - totalOut,
      countIn: Number(r.count_in ?? 0),
      countOut: Number(r.count_out ?? 0),
      byCategory,
      perAccount,
    };
  } finally {
    conn.release();
  }
}

/* ---------- Cash Flow: Akun ---------- */

interface AccountRow extends RowDataPacket {
  id: string;
  name: string;
  type: AccountType;
  created_at: string;
}

function rowToAccount(row: AccountRow): CashflowAccount {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    createdAt: fromMysql(row.created_at) ?? todayISO(),
  };
}

export async function getAccounts(): Promise<CashflowAccount[]> {
  const conn = await getConn();
  try {
    const [rows] = await conn.query<AccountRow[]>(
      "SELECT * FROM cashflow_accounts ORDER BY created_at ASC"
    );
    return rows.map(rowToAccount);
  } finally {
    conn.release();
  }
}

export async function getAccount(id: string): Promise<CashflowAccount | undefined> {
  const conn = await getConn();
  try {
    const [rows] = await conn.query<AccountRow[]>(
      "SELECT * FROM cashflow_accounts WHERE id = ?",
      [id]
    );
    return rows.length ? rowToAccount(rows[0]) : undefined;
  } finally {
    conn.release();
  }
}

export async function insertAccount(a: CashflowAccount): Promise<CashflowAccount> {
  const conn = await getConn();
  try {
    await conn.query(
      "INSERT INTO cashflow_accounts (id, name, type, created_at) VALUES (?, ?, ?, ?)",
      [a.id, a.name, a.type, toMysql(a.createdAt)]
    );
    return a;
  } finally {
    conn.release();
  }
}

export async function updateAccount(
  id: string,
  patch: Partial<CashflowAccount>
): Promise<CashflowAccount | undefined> {
  const conn = await getConn();
  try {
    const current = await getAccount(id);
    if (!current) return undefined;
    const merged = { ...current, ...patch };
    await conn.query(
      "UPDATE cashflow_accounts SET name = ?, type = ? WHERE id = ?",
      [merged.name, merged.type, id]
    );
    if (patch.name && patch.name !== current.name) {
      await conn.query("UPDATE transactions SET account = ? WHERE account = ?", [
        patch.name,
        current.name,
      ]);
    }
    return merged;
  } finally {
    conn.release();
  }
}

export async function deleteAccount(
  id: string
): Promise<{ removed: boolean; inUse: boolean }> {
  const conn = await getConn();
  try {
    const account = await getAccount(id);
    if (!account) return { removed: false, inUse: false };
    const [used] = await conn.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS cnt FROM transactions WHERE account = ?",
      [account.name]
    );
    if (Number(used[0]?.cnt ?? 0) > 0) return { removed: false, inUse: true };
    const [res] = await conn.query<ResultSetHeader>(
      "DELETE FROM cashflow_accounts WHERE id = ?",
      [id]
    );
    return { removed: res.affectedRows > 0, inUse: false };
  } finally {
    conn.release();
  }
}

export async function createTransfer(opts: {
  from: string;
  to: string;
  amount: number;
  date?: string;
}): Promise<{ fromTxn: Transaction; toTxn: Transaction }> {
  const now = todayISO();
  const date = opts.date ?? now.slice(0, 10);
  const fromTxn: Transaction = {
    id: uid("t_"),
    type: "out",
    amount: opts.amount,
    category: "Transfer",
    account: opts.from,
    description: `Transfer ke ${opts.to}`,
    date,
    createdAt: now,
  };
  const toTxn: Transaction = {
    id: uid("t_"),
    type: "in",
    amount: opts.amount,
    category: "Transfer",
    account: opts.to,
    description: `Transfer dari ${opts.from}`,
    date,
    createdAt: now,
  };
  await insertTransaction(fromTxn);
  await insertTransaction(toTxn);
  return { fromTxn, toTxn };
}

/* ---------- Cash Flow: Settings ---------- */

export async function getCashflowSettings(): Promise<CashflowSettings> {
  const conn = await getConn();
  try {
    const [rows] = await conn.query<RowDataPacket[]>(
      "SELECT target_amount, target_type FROM cashflow_settings WHERE id = 1"
    );
    const row = rows[0] ?? {};
    return {
      targetAmount: Number(row.target_amount ?? 0),
      targetType: "saving",
    };
  } finally {
    conn.release();
  }
}

export async function saveCashflowSettings(
  s: CashflowSettings
): Promise<CashflowSettings> {
  const conn = await getConn();
  try {
    await conn.query(
      `INSERT INTO cashflow_settings (id, target_amount, target_type)
       VALUES (1, ?, 'saving')
       ON DUPLICATE KEY UPDATE target_amount = VALUES(target_amount), target_type = 'saving'`,
      [s.targetAmount]
    );
    return s;
  } finally {
    conn.release();
  }
}

/* ---------- Notes ---------- */

interface NoteRow extends RowDataPacket {
  id: string;
  title: string;
  content: string | null;
  tags: string | unknown;
  pinned: number;
  created_at: string;
  updated_at: string;
}

function rowToNote(row: NoteRow): Note {
  return {
    id: row.id,
    title: row.title,
    content: row.content ?? "",
    tags: parseJson<string[]>(row.tags, []),
    pinned: Boolean(row.pinned),
    createdAt: fromMysql(row.created_at) ?? todayISO(),
    updatedAt: fromMysql(row.updated_at) ?? todayISO(),
  };
}

export async function getNotes(opts: { search?: string; tag?: string } = {}): Promise<Note[]> {
  const conn = await getConn();
  try {
    const where: string[] = [];
    const params: string[] = [];
    if (opts.search) {
      where.push("(title LIKE ? OR content LIKE ?)");
      const like = `%${opts.search}%`;
      params.push(like, like);
    }
    if (opts.tag) {
      where.push("JSON_CONTAINS(tags, ?)");
      params.push(JSON.stringify(opts.tag));
    }
    const sql =
      "SELECT * FROM notes" +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY pinned DESC, updated_at DESC";
    const [rows] = await conn.query<NoteRow[]>(sql, params);
    return rows.map(rowToNote);
  } finally {
    conn.release();
  }
}

export async function getNote(id: string): Promise<Note | undefined> {
  const conn = await getConn();
  try {
    const [rows] = await conn.query<NoteRow[]>("SELECT * FROM notes WHERE id = ?", [id]);
    return rows.length ? rowToNote(rows[0]) : undefined;
  } finally {
    conn.release();
  }
}

export async function insertNote(n: Note): Promise<Note> {
  const conn = await getConn();
  try {
    await conn.query(
      `INSERT INTO notes (id, title, content, tags, pinned, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [n.id, n.title, n.content, JSON.stringify(n.tags), n.pinned ? 1 : 0, toMysql(n.createdAt), toMysql(n.updatedAt)]
    );
    return n;
  } finally {
    conn.release();
  }
}

export async function updateNote(
  id: string,
  patch: Partial<Note>
): Promise<Note | undefined> {
  const conn = await getConn();
  try {
    const current = await getNote(id);
    if (!current) return undefined;
    const merged = { ...current, ...patch, updatedAt: todayISO() };
    await conn.query(
      "UPDATE notes SET title = ?, content = ?, tags = ?, pinned = ?, updated_at = ? WHERE id = ?",
      [
        merged.title,
        merged.content,
        JSON.stringify(merged.tags),
        merged.pinned ? 1 : 0,
        toMysql(merged.updatedAt),
        id,
      ]
    );
    return merged;
  } finally {
    conn.release();
  }
}

export async function deleteNote(id: string): Promise<boolean> {
  const conn = await getConn();
  try {
    const [res] = await conn.query<ResultSetHeader>("DELETE FROM notes WHERE id = ?", [id]);
    return res.affectedRows > 0;
  } finally {
    conn.release();
  }
}

export async function getNoteTags(): Promise<string[]> {
  const conn = await getConn();
  try {
    const [rows] = await conn.query<RowDataPacket[]>("SELECT tags FROM notes");
    const tags = new Set<string>();
    rows.forEach((r) => {
      const arr = parseJson<string[]>(r.tags, []);
      arr.forEach((t) => tags.add(t));
    });
    return Array.from(tags).sort((a, b) => a.localeCompare(b));
  } finally {
    conn.release();
  }
}

/* ---------- Tasks ---------- */

interface TaskRow extends RowDataPacket {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  due_date: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function dateToSql(date?: string): string | null {
  if (!date) return null;
  const m = String(date).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? undefined,
    status: row.status,
    priority: row.priority,
    dueDate: row.due_date ?? undefined,
    createdAt: fromMysql(row.created_at) ?? todayISO(),
    updatedAt: fromMysql(row.updated_at) ?? todayISO(),
    completedAt: row.completed_at ? fromMysql(row.completed_at) : undefined,
  };
}

export async function getTasks(opts: {
  status?: string;
  priority?: string;
  search?: string;
  dueDate?: string;
} = {}): Promise<Task[]> {
  const conn = await getConn();
  try {
    const where: string[] = [];
    const params: string[] = [];
    if (opts.status === "todo" || opts.status === "in_progress" || opts.status === "done") {
      where.push("status = ?");
      params.push(opts.status);
    }
    if (opts.priority === "low" || opts.priority === "medium" || opts.priority === "high") {
      where.push("priority = ?");
      params.push(opts.priority);
    }
    if (opts.search) {
      where.push("(title LIKE ? OR description LIKE ?)");
      const like = `%${opts.search}%`;
      params.push(like, like);
    }
    if (opts.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(opts.dueDate)) {
      where.push("due_date = ?");
      params.push(opts.dueDate);
    }
    const sql =
      "SELECT * FROM tasks" +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY (status = 'done') ASC, due_date IS NULL ASC, due_date ASC, created_at DESC";
    const [rows] = await conn.query<TaskRow[]>(sql, params);
    return rows.map(rowToTask);
  } finally {
    conn.release();
  }
}

export async function getTask(id: string): Promise<Task | undefined> {
  const conn = await getConn();
  try {
    const [rows] = await conn.query<TaskRow[]>("SELECT * FROM tasks WHERE id = ?", [id]);
    return rows.length ? rowToTask(rows[0]) : undefined;
  } finally {
    conn.release();
  }
}

export async function insertTask(t: Task): Promise<Task> {
  const conn = await getConn();
  try {
    await conn.query(
      `INSERT INTO tasks (id, title, description, status, priority, due_date, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        t.id,
        t.title,
        t.description ?? "",
        t.status,
        t.priority,
        dateToSql(t.dueDate),
        toMysql(t.createdAt),
        toMysql(t.updatedAt),
        toMysql(t.completedAt),
      ]
    );
    return t;
  } finally {
    conn.release();
  }
}

export async function updateTask(
  id: string,
  patch: Partial<Task>
): Promise<Task | undefined> {
  const conn = await getConn();
  try {
    const current = await getTask(id);
    if (!current) return undefined;
    const merged = { ...current, ...patch, updatedAt: todayISO() };
    await conn.query(
      `UPDATE tasks SET
        title = ?, description = ?, status = ?, priority = ?, due_date = ?, updated_at = ?, completed_at = ?
       WHERE id = ?`,
      [
        merged.title,
        merged.description ?? "",
        merged.status,
        merged.priority,
        dateToSql(merged.dueDate),
        toMysql(merged.updatedAt),
        toMysql(merged.completedAt),
        id,
      ]
    );
    return merged;
  } finally {
    conn.release();
  }
}

export async function deleteTask(id: string): Promise<boolean> {
  const conn = await getConn();
  try {
    const [res] = await conn.query<ResultSetHeader>("DELETE FROM tasks WHERE id = ?", [id]);
    return res.affectedRows > 0;
  } finally {
    conn.release();
  }
}

export async function getTaskStats(): Promise<TaskStats> {
  const conn = await getConn();
  try {
    const today = new Date();
    const todaySql = toMysql(today.toISOString()) ?? "";
    const todayDate = todaySql.slice(0, 10);

    const [byStatus] = await conn.query<RowDataPacket[]>(
      "SELECT status, COUNT(*) AS cnt FROM tasks GROUP BY status"
    );
    const counts: Record<string, number> = {};
    byStatus.forEach((r) => {
      counts[String(r.status)] = Number(r.cnt);
    });

    const [totalRow] = await conn.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS total FROM tasks"
    );
    const [overdueRow] = await conn.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS cnt FROM tasks WHERE status != 'done' AND due_date IS NOT NULL AND due_date < ?",
      [todayDate]
    );
    const [dueTodayRow] = await conn.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS cnt FROM tasks WHERE status != 'done' AND due_date = ?",
      [todayDate]
    );
    const [doneTodayRow] = await conn.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS cnt FROM tasks WHERE status = 'done' AND completed_at >= ?",
      [todaySql]
    );

    return {
      total: Number(totalRow[0]?.total ?? 0),
      todo: counts.todo ?? 0,
      inProgress: counts.in_progress ?? 0,
      done: counts.done ?? 0,
      overdue: Number(overdueRow[0]?.cnt ?? 0),
      dueToday: Number(dueTodayRow[0]?.cnt ?? 0),
      doneToday: Number(doneTodayRow[0]?.cnt ?? 0),
    };
  } finally {
    conn.release();
  }
}