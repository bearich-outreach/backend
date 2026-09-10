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
  QualifiedLead,
  RawLead,
  SearchTarget,
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

// Pagination: tetap 10 baris per halaman di semua daftar.
export const PAGE_SIZE = 10;
export function parsePage(value: unknown): number {
  const p = Number(value);
  return Number.isFinite(p) && p >= 1 ? Math.floor(p) : 1;
}
export function pageOffset(page: number, pageSize = PAGE_SIZE): number {
  return (Math.max(page, 1) - 1) * pageSize;
}

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
        sort_order INT NOT NULL DEFAULT 0,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        completed_at DATETIME(3) NULL,
        INDEX idx_status (status),
        INDEX idx_due (due_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    try {
      await conn.query("ALTER TABLE tasks ADD COLUMN sort_order INT NOT NULL DEFAULT 0");
      // Kolom baru dibuat -> backfill sekali dari urutan prioritas + tenggat.
      // idempotent: hanya jalan saat ALTER sukses (tabel lama tanpa kolom).
      await backfillTaskSortOrder(conn);
    } catch { /* kolom sudah ada, urutan manual dipertahankan */ }

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
        {
          slug: "jobs",
          name: "Job Hunter",
          description: "Cari & kumpulkan lowongan remote Glints + JobStreet",
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

    // Autopilot tables
    await conn.query(`
      CREATE TABLE IF NOT EXISTS search_targets (
        id VARCHAR(40) PRIMARY KEY,
        keyword VARCHAR(255) NOT NULL,
        city VARCHAR(100) NOT NULL,
        category VARCHAR(100) NOT NULL,
        status ENUM('PENDING','PROCESSING','DONE','FAILED') NOT NULL DEFAULT 'PENDING',
        attempts INT NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY uq_keyword (keyword),
        INDEX idx_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS raw_leads (
        id VARCHAR(40) PRIMARY KEY,
        place_id VARCHAR(100) NOT NULL,
        name VARCHAR(255) NOT NULL,
        address TEXT,
        phone_raw VARCHAR(50) DEFAULT '',
        website VARCHAR(255) DEFAULT '',
        rating DECIMAL(2,1) NULL,
        review_count INT NOT NULL DEFAULT 0,
        maps_status ENUM('OPERATIONAL','CLOSED_PERMANENTLY','UNKNOWN') NOT NULL DEFAULT 'UNKNOWN',
        city VARCHAR(100) NOT NULL DEFAULT '',
        category VARCHAR(100) NOT NULL DEFAULT '',
        keyword VARCHAR(255) NOT NULL DEFAULT '',
        raw_json JSON,
        created_at DATETIME(3) NOT NULL,
        last_seen_at DATETIME(3) NOT NULL,
        UNIQUE KEY uq_place (place_id),
        INDEX idx_city_cat (city, category)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS qualified_leads (
        id VARCHAR(40) PRIMARY KEY,
        place_id VARCHAR(100) NOT NULL,
        name VARCHAR(255) NOT NULL,
        company VARCHAR(255) NOT NULL DEFAULT '',
        address TEXT NULL,
        phone_628 VARCHAR(20) NOT NULL,
        city VARCHAR(100) NOT NULL DEFAULT '',
        category VARCHAR(100) NOT NULL DEFAULT '',
        rating DECIMAL(2,1) NULL,
        review_count INT NOT NULL DEFAULT 0,
        website VARCHAR(255) DEFAULT '',
        maps_url VARCHAR(600) NOT NULL DEFAULT '',
        score INT NOT NULL,
        wa_verified TINYINT(1) NOT NULL DEFAULT 0,
        message TEXT,
        message_variants JSON,
        status ENUM('New Lead','Contacted','Replied') NOT NULL DEFAULT 'New Lead',
        created_at DATETIME(3) NOT NULL,
        contacted_at DATETIME(3) NULL,
        replied_at DATETIME(3) NULL,
        UNIQUE KEY uq_place (place_id),
        UNIQUE KEY uq_phone (phone_628),
        INDEX idx_status (status),
        INDEX idx_score (score)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS webhook_logs (
        id VARCHAR(40) PRIMARY KEY,
        phone_628 VARCHAR(20) NOT NULL DEFAULT '',
        event VARCHAR(50) NOT NULL DEFAULT '',
        payload JSON,
        created_at DATETIME(3) NOT NULL,
        INDEX idx_phone (phone_628)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS outreach_daily_counter (
        date DATE PRIMARY KEY,
        count INT NOT NULL DEFAULT 0
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS deepseek_daily_counter (
        date DATE PRIMARY KEY,
        count INT NOT NULL DEFAULT 0
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS wa_verify_pending (
        place_id VARCHAR(100) PRIMARY KEY,
        phone_628 VARCHAR(20) NOT NULL,
        name VARCHAR(255) NOT NULL DEFAULT '',
        city VARCHAR(100) NOT NULL DEFAULT '',
        category VARCHAR(100) NOT NULL DEFAULT '',
        attempts INT NOT NULL DEFAULT 0,
        next_retry_at DATETIME(3) NOT NULL,
        created_at DATETIME(3) NOT NULL,
        INDEX idx_retry (next_retry_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    // Migrasi kolom baru qualified_leads untuk tabel lama di production
    try { await conn.query("ALTER TABLE qualified_leads ADD COLUMN address TEXT NULL AFTER company"); } catch { /* kolom sudah ada */ }
    try { await conn.query("ALTER TABLE qualified_leads ADD COLUMN maps_url VARCHAR(600) NOT NULL DEFAULT '' AFTER website"); } catch { /* kolom sudah ada */ }

    /* ---------- Jobs app: isolasi penuh, hanya CREATE IF NOT EXISTS ---------- */
    await conn.query(`
      CREATE TABLE IF NOT EXISTS job_targets (
        id VARCHAR(40) PRIMARY KEY,
        keyword VARCHAR(255) NOT NULL,
        source ENUM('glints','jobstreet') NOT NULL DEFAULT 'glints',
        status ENUM('PENDING','PROCESSING','DONE','FAILED') NOT NULL DEFAULT 'PENDING',
        attempts INT NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY uq_keyword_source (keyword, source),
        INDEX idx_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS job_raw (
        id VARCHAR(40) PRIMARY KEY,
        source ENUM('glints','jobstreet') NOT NULL DEFAULT 'glints',
        external_id VARCHAR(255) NOT NULL,
        title VARCHAR(255) NOT NULL DEFAULT '',
        company VARCHAR(255) NOT NULL DEFAULT '',
        location VARCHAR(255) NOT NULL DEFAULT '',
        url VARCHAR(1000) NOT NULL DEFAULT '',
        posted_date DATETIME(3) NULL,
        payload JSON,
        reason_skipped VARCHAR(100) NOT NULL DEFAULT '',
        created_at DATETIME(3) NOT NULL,
        last_seen_at DATETIME(3) NOT NULL,
        UNIQUE KEY uq_source_ext (source, external_id),
        UNIQUE KEY uq_norm_url (url(255)),
        INDEX idx_seen (last_seen_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS job_listings (
        id VARCHAR(40) PRIMARY KEY,
        source ENUM('glints','jobstreet') NOT NULL DEFAULT 'glints',
        external_id VARCHAR(255) NOT NULL,
        title VARCHAR(255) NOT NULL DEFAULT '',
        company VARCHAR(255) NOT NULL DEFAULT '',
        location VARCHAR(255) NOT NULL DEFAULT 'Remote',
        url VARCHAR(1000) NOT NULL DEFAULT '',
        salary_text VARCHAR(255) NOT NULL DEFAULT '',
        remote_label ENUM('Remote','Perlu Cek') NOT NULL DEFAULT 'Perlu Cek',
        review_flag TINYINT(1) NOT NULL DEFAULT 0,
        score INT NOT NULL DEFAULT 0,
        status ENUM('New','Saved','Applied','Interview','Rejected') NOT NULL DEFAULT 'New',
        hidden TINYINT(1) NOT NULL DEFAULT 0,
        posted_date DATETIME(3) NULL,
        first_seen_at DATETIME(3) NOT NULL,
        last_seen_at DATETIME(3) NOT NULL,
        created_at DATETIME(3) NOT NULL,
        UNIQUE KEY uq_source_ext (source, external_id),
        INDEX idx_status_hidden (status, hidden),
        INDEX idx_score (score),
        INDEX idx_posted (posted_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
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

export interface TransactionFilter {
  month?: string;
  date?: string;
  startDate?: string;
  endDate?: string;
  type?: string;
  category?: string;
  account?: string;
}

function buildTransactionWhere(opts: TransactionFilter): { where: string[]; params: (string | number)[] } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.startDate || opts.endDate) {
    let sd = opts.startDate && /^\d{4}-\d{2}-\d{2}$/.test(opts.startDate) ? opts.startDate : null;
    let ed = opts.endDate && /^\d{4}-\d{2}-\d{2}$/.test(opts.endDate) ? opts.endDate : null;
    if (sd && ed) {
      if (sd > ed) [sd, ed] = [ed, sd];
      where.push("txn_date >= ? AND txn_date <= ?");
      params.push(sd, ed);
    } else if (sd) {
      where.push("txn_date = ?");
      params.push(sd);
    } else if (ed) {
      where.push("txn_date = ?");
      params.push(ed);
    }
  } else if (opts.date && /^\d{4}-\d{2}-\d{2}$/.test(opts.date)) {
    where.push("txn_date = ?");
    params.push(opts.date);
  } else if (opts.month) {
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
  return { where, params };
}

export async function getTransactions(opts: TransactionFilter & {
  limit?: number;
  offset?: number;
} = {}): Promise<Transaction[]> {
  const conn = await getConn();
  try {
    const { where, params } = buildTransactionWhere(opts);
    const lim = Math.min(Math.max(Math.floor(Number(opts.limit) || 5000), 1), 5000);
    const off = Math.max(Math.floor(Number(opts.offset) || 0), 0);
    const sql =
      "SELECT * FROM transactions" +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY txn_date DESC, created_at DESC LIMIT " + lim + " OFFSET " + off;
    const [rows] = await conn.query<TransactionRow[]>(sql, params);
    return rows.map(rowToTransaction);
  } finally {
    conn.release();
  }
}

// Total + nominal (in/out) dihitung server dari SELURUH data terfilter, bukan halaman aktif.
export async function countTransactionsFiltered(opts: TransactionFilter = {}): Promise<{ total: number; totalIn: number; totalOut: number }> {
  const conn = await getConn();
  try {
    const { where, params } = buildTransactionWhere(opts);
    const sql =
      "SELECT COUNT(*) total, COALESCE(SUM(CASE WHEN type='in' THEN amount ELSE 0 END),0) totalIn, COALESCE(SUM(CASE WHEN type='out' THEN amount ELSE 0 END),0) totalOut FROM transactions" +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "");
    const [rows] = await conn.query<RowDataPacket[]>(sql, params);
    return {
      total: Number(rows[0]?.total ?? 0),
      totalIn: Number(rows[0]?.totalIn ?? 0),
      totalOut: Number(rows[0]?.totalOut ?? 0),
    };
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
  opts: { month?: string; date?: string; startDate?: string; endDate?: string } = {}
): Promise<CashflowSummary> {
  const conn = await getConn();
  try {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.startDate || opts.endDate) {
      let sd = opts.startDate && /^\d{4}-\d{2}-\d{2}$/.test(opts.startDate) ? opts.startDate : null;
      let ed = opts.endDate && /^\d{4}-\d{2}-\d{2}$/.test(opts.endDate) ? opts.endDate : null;
      if (sd && ed) {
        if (sd > ed) [sd, ed] = [ed, sd];
        where.push("txn_date >= ? AND txn_date <= ?");
        params.push(sd, ed);
      } else if (sd) {
        where.push("txn_date = ?");
        params.push(sd);
      } else if (ed) {
        where.push("txn_date = ?");
        params.push(ed);
      }
    } else if (opts.date && /^\d{4}-\d{2}-\d{2}$/.test(opts.date)) {
      where.push("txn_date = ?");
      params.push(opts.date);
    } else if (opts.month) {
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
  sort_order: number | null;
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
    sortOrder: Number(row.sort_order ?? 0),
    createdAt: fromMysql(row.created_at) ?? todayISO(),
    updatedAt: fromMysql(row.updated_at) ?? todayISO(),
    completedAt: row.completed_at ? fromMysql(row.completed_at) : undefined,
  };
}

const TASK_PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

// Backfill satu-kali: urutan awal = prioritas high->low, lalu tenggat terdekat.
async function backfillTaskSortOrder(conn: PoolConnection): Promise<void> {
  const [rows] = await conn.query<TaskRow[]>(
    "SELECT id FROM tasks WHERE status != 'done' ORDER BY FIELD(priority,'high','medium','low'), due_date IS NULL ASC, due_date ASC, created_at ASC"
  );
  for (let i = 0; i < rows.length; i++) {
    await conn.query("UPDATE tasks SET sort_order = ? WHERE id = ?", [i, rows[i].id]);
  }
}

export async function getActiveTasksSorted(): Promise<Task[]> {
  const conn = await getConn();
  try {
    const [rows] = await conn.query<TaskRow[]>("SELECT * FROM tasks WHERE status != 'done' ORDER BY sort_order ASC");
    return rows.map(rowToTask);
  } finally { conn.release(); }
}

// Posisi sisip otomatis: prioritas high->low, lalu tenggat terdekat (tanpa tanggal = paling belakang).
export function autoInsertIndex(
  list: { priority: string; dueDate?: string }[],
  priority: string,
  dueDate?: string
): number {
  const rank = (p: string) => TASK_PRIORITY_RANK[p] ?? 1;
  const time = (d?: string) => (d ? new Date(d + "T00:00:00").getTime() : Number.POSITIVE_INFINITY);
  const idx = list.findIndex(
    (t) => rank(priority) < rank(t.priority) || (rank(priority) === rank(t.priority) && time(dueDate) < time(t.dueDate))
  );
  return idx === -1 ? list.length : idx;
}

export async function shiftActiveSortOrders(from: number): Promise<void> {
  const conn = await getConn();
  try {
    await conn.query("UPDATE tasks SET sort_order = sort_order + 1 WHERE status != 'done' AND sort_order >= ?", [from]);
  } finally { conn.release(); }
}

// Tulis ulang urutan manual baris aktif. Menolak subset (filter aktif) agar tidak korup.
export async function reorderActiveTasks(orderedIds: string[]): Promise<void> {
  const conn = await getConn();
  try {
    const [rows] = await conn.query<TaskRow[]>("SELECT id FROM tasks WHERE status != 'done'");
    const activeIds = new Set(rows.map((r) => r.id));
    if (orderedIds.length !== activeIds.size || !orderedIds.every((id) => activeIds.has(id))) {
      throw new Error("daftar id tidak cocok dengan seluruh tugas aktif (nonaktifkan filter dulu)");
    }
    for (let i = 0; i < orderedIds.length; i++) {
      await conn.query("UPDATE tasks SET sort_order = ? WHERE id = ?", [i, orderedIds[i]]);
    }
  } finally { conn.release(); }
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
      " ORDER BY (status = 'done') ASC, CASE WHEN status = 'done' THEN 0 ELSE sort_order END ASC, completed_at DESC, due_date IS NULL ASC, due_date ASC, created_at DESC";
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
      `INSERT INTO tasks (id, title, description, status, priority, due_date, sort_order, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        t.id,
        t.title,
        t.description ?? "",
        t.status,
        t.priority,
        dateToSql(t.dueDate),
        t.sortOrder ?? 0,
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
        title = ?, description = ?, status = ?, priority = ?, due_date = ?, sort_order = ?, updated_at = ?, completed_at = ?
       WHERE id = ?`,
      [
        merged.title,
        merged.description ?? "",
        merged.status,
        merged.priority,
        dateToSql(merged.dueDate),
        merged.sortOrder ?? 0,
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
      "SELECT COUNT(*) AS cnt FROM tasks WHERE status = 'done' AND DATE(completed_at) = ?",
      [todayDate]
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

/* ---------- Autopilot ---------- */

interface SearchTargetRow extends RowDataPacket {
  id: string;
  keyword: string;
  city: string;
  category: string;
  status: SearchTarget["status"];
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}
function rowToSearchTarget(r: SearchTargetRow): import("./types").SearchTarget {
  return {
    id: r.id,
    keyword: r.keyword,
    city: r.city,
    category: r.category,
    status: r.status,
    attempts: Number(r.attempts),
    lastError: r.last_error ?? undefined,
    createdAt: fromMysql(r.created_at) ?? todayISO(),
    updatedAt: fromMysql(r.updated_at) ?? todayISO(),
  };
}
export async function getSearchTargets(opts: { status?: string; limit?: number; offset?: number } = {}) {
  const conn = await getConn();
  try {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.status) { where.push("status = ?"); params.push(opts.status); }
    const limit = Math.min(Math.max(Math.floor(Number(opts.limit) || 100), 1), 1000);
    const off = Math.max(Math.floor(Number(opts.offset) || 0), 0);
    const sql = "SELECT * FROM search_targets" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY created_at ASC LIMIT " + limit + " OFFSET " + off;
    const [rows] = await conn.query<SearchTargetRow[]>(sql, params);
    return rows.map(rowToSearchTarget);
  } finally { conn.release(); }
}
export async function countSearchTargets() {
  const conn = await getConn();
  try {
    const [rows] = await conn.query<RowDataPacket[]>("SELECT status, COUNT(*) cnt FROM search_targets GROUP BY status");
    const byStatus: Record<string, number> = {};
    let total = 0;
    rows.forEach(r => { byStatus[String(r.status)] = Number(r.cnt); total += Number(r.cnt); });
    return { total, byStatus };
  } finally { conn.release(); }
}
export async function insertSearchTarget(t: import("./types").SearchTarget) {
  const conn = await getConn();
  try {
    await conn.query(
      "INSERT INTO search_targets (id, keyword, city, category, status, attempts, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE updated_at=VALUES(updated_at)",
      [t.id, t.keyword, t.city, t.category, t.status, t.attempts, t.lastError ?? null, toMysql(t.createdAt), toMysql(t.updatedAt)]
    );
  } finally { conn.release(); }
}
export async function updateSearchTarget(id: string, patch: Partial<import("./types").SearchTarget>) {
  const conn = await getConn();
  try {
    const sets: string[] = []; const params: unknown[] = [];
    if (patch.status) { sets.push("status = ?"); params.push(patch.status); }
    if (patch.attempts !== undefined) { sets.push("attempts = ?"); params.push(patch.attempts); }
    if (patch.lastError !== undefined) { sets.push("last_error = ?"); params.push(patch.lastError); }
    sets.push("updated_at = ?"); params.push(toMysql(todayISO()));
    params.push(id);
    await conn.query(`UPDATE search_targets SET ${sets.join(", ")} WHERE id = ?`, params);
  } finally { conn.release(); }
}
// Kembalikan semua target FAILED -> PENDING agar bisa dicoba lagi (mis. setelah throttling).
export async function retryFailedTargets(): Promise<{ retried: number }> {
  const conn = await getConn();
  try {
    const [r] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) total FROM search_targets WHERE status='FAILED'");
    const retried = Number(r[0]?.total ?? 0);
    await conn.query("UPDATE search_targets SET status='PENDING', last_error=NULL, updated_at=? WHERE status='FAILED'", [toMysql(todayISO())]);
    return { retried };
  } finally { conn.release(); }
}
export async function claimNextSearchTarget(): Promise<import("./types").SearchTarget | undefined> {
  const conn = await getConn();
  try {
    await conn.query("START TRANSACTION");
    const [rows] = await conn.query<SearchTargetRow[]>(
      "SELECT * FROM search_targets WHERE status='PENDING' ORDER BY created_at ASC LIMIT 1 FOR UPDATE"
    );
    if (!rows.length) { await conn.query("COMMIT"); return undefined; }
    const t = rows[0];
    await conn.query("UPDATE search_targets SET status='PROCESSING', attempts=attempts+1, updated_at=? WHERE id=?", [toMysql(todayISO()), t.id]);
    await conn.query("COMMIT");
    return rowToSearchTarget({ ...t, status: "PROCESSING", attempts: Number(t.attempts)+1 });
  } catch {
    try { await conn.query("ROLLBACK"); } catch {}
    return undefined;
  } finally { conn.release(); }
}

interface RawLeadRow extends RowDataPacket {
  id: string; place_id: string; name: string; address: string | null; phone_raw: string; website: string; rating: string | null; review_count: number; maps_status: RawLead["mapsStatus"]; city: string; category: string; keyword: string; raw_json: string | unknown; created_at: string; last_seen_at: string;
}
function rowToRawLead(r: RawLeadRow): RawLead {
  return {
    id: r.id, placeId: r.place_id, name: r.name, address: r.address ?? undefined, phoneRaw: r.phone_raw ?? undefined, website: r.website ?? undefined,
    rating: r.rating == null ? undefined : Number(r.rating), reviewCount: Number(r.review_count), mapsStatus: r.maps_status, city: r.city ?? undefined, category: r.category ?? undefined, keyword: r.keyword ?? undefined, rawJson: parseJson(r.raw_json, undefined), createdAt: fromMysql(r.created_at) ?? todayISO(), lastSeenAt: fromMysql(r.last_seen_at) ?? todayISO(),
  };
}
export async function upsertRawLead(lead: RawLead) {
  const conn = await getConn();
  try {
    await conn.query(
      `INSERT INTO raw_leads (id, place_id, name, address, phone_raw, website, rating, review_count, maps_status, city, category, keyword, raw_json, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE last_seen_at=VALUES(last_seen_at), raw_json=VALUES(raw_json), rating=VALUES(rating), review_count=VALUES(review_count), phone_raw=VALUES(phone_raw), website=VALUES(website)`,
      [lead.id, lead.placeId, lead.name, lead.address ?? "", lead.phoneRaw ?? "", lead.website ?? "", lead.rating ?? null, lead.reviewCount, lead.mapsStatus, lead.city ?? "", lead.category ?? "", lead.keyword ?? "", lead.rawJson ? JSON.stringify(lead.rawJson) : null, toMysql(lead.createdAt), toMysql(lead.lastSeenAt)]
    );
  } finally { conn.release(); }
}
export async function getRawLeads(opts: { city?: string; category?: string; limit?: number; offset?: number } = {}) {
  const conn = await getConn();
  try {
    const where: string[] = []; const params: unknown[] = [];
    if (opts.city) { where.push("city = ?"); params.push(opts.city); }
    if (opts.category) { where.push("category = ?"); params.push(opts.category); }
    const lim = Math.min(Math.max(Math.floor(Number(opts.limit) || 50), 1), 500);
    const off = Math.max(Math.floor(Number(opts.offset) || 0), 0);
    const sql = "SELECT * FROM raw_leads" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY last_seen_at DESC LIMIT " + lim + " OFFSET " + off;
    const [rows] = await conn.query<RawLeadRow[]>(sql, params);
    return rows.map(rowToRawLead);
  } finally { conn.release(); }
}
export async function countRawLeadsFiltered(opts: { city?: string; category?: string } = {}) {
  const conn = await getConn();
  try {
    const where: string[] = []; const params: unknown[] = [];
    if (opts.city) { where.push("city = ?"); params.push(opts.city); }
    if (opts.category) { where.push("category = ?"); params.push(opts.category); }
    const sql = "SELECT COUNT(*) total FROM raw_leads" + (where.length ? " WHERE " + where.join(" AND ") : "");
    const [r] = await conn.query<RowDataPacket[]>(sql, params);
    return Number(r[0]?.total ?? 0);
  } finally { conn.release(); }
}
export async function countRawLeads() {
  const conn = await getConn();
  try { const [r] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) total FROM raw_leads"); return Number(r[0]?.total ?? 0); } finally { conn.release(); }
}

interface QualifiedLeadRow extends RowDataPacket {
  id: string; place_id: string; name: string; company: string; address: string | null; phone_628: string; city: string; category: string; rating: string | null; review_count: number; website: string; maps_url: string | null; score: number; wa_verified: number; message: string | null; message_variants: string | unknown; status: QualifiedLead["status"]; created_at: string; contacted_at: string | null; replied_at: string | null;
}
function rowToQualifiedLead(r: QualifiedLeadRow): QualifiedLead {
  return {
    id: r.id, placeId: r.place_id, name: r.name, company: r.company ?? undefined, address: r.address ?? undefined, phone628: r.phone_628, city: r.city ?? undefined, category: r.category ?? undefined, rating: r.rating == null ? undefined : Number(r.rating), reviewCount: Number(r.review_count), website: r.website ?? undefined, mapsUrl: r.maps_url ?? undefined, score: Number(r.score), waVerified: Boolean(r.wa_verified), message: r.message ?? undefined, messageVariants: parseJson<string[] | undefined>(r.message_variants, undefined), status: r.status, createdAt: fromMysql(r.created_at) ?? todayISO(), contactedAt: fromMysql(r.contacted_at ?? undefined), repliedAt: fromMysql(r.replied_at ?? undefined),
  };
}
export async function getQualifiedLeads(opts: { status?: string; limit?: number; offset?: number; waVerifiedOnly?: boolean } = {}) {
  const conn = await getConn();
  try {
    const where: string[] = []; const params: unknown[] = [];
    if (opts.status) { where.push("status = ?"); params.push(opts.status); }
    if (opts.waVerifiedOnly !== false) { where.push("wa_verified = 1"); }
    const lim = Math.min(Math.max(Math.floor(Number(opts.limit) || 100), 1), 1000);
    const off = Math.max(Math.floor(Number(opts.offset) || 0), 0);
    const sql = "SELECT * FROM qualified_leads" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY score DESC, created_at DESC LIMIT " + lim + " OFFSET " + off;
    const [rows] = await conn.query<QualifiedLeadRow[]>(sql, params);
    return rows.map(rowToQualifiedLead);
  } finally { conn.release(); }
}
export async function countQualifiedLeadsFiltered(opts: { status?: string; waVerifiedOnly?: boolean } = {}) {
  const conn = await getConn();
  try {
    const where: string[] = []; const params: unknown[] = [];
    if (opts.status) { where.push("status = ?"); params.push(opts.status); }
    if (opts.waVerifiedOnly !== false) { where.push("wa_verified = 1"); }
    const sql = "SELECT COUNT(*) total FROM qualified_leads" + (where.length ? " WHERE " + where.join(" AND ") : "");
    const [r] = await conn.query<RowDataPacket[]>(sql, params);
    return Number(r[0]?.total ?? 0);
  } finally { conn.release(); }
}
export async function getQualifiedLead(id: string) {
  const conn = await getConn();
  try { const [rows] = await conn.query<QualifiedLeadRow[]>("SELECT * FROM qualified_leads WHERE id = ?", [id]); return rows.length ? rowToQualifiedLead(rows[0]) : undefined; } finally { conn.release(); }
}
export async function countQualifiedLeads() {
  const conn = await getConn();
  try {
    const [rows] = await conn.query<RowDataPacket[]>("SELECT status, COUNT(*) cnt FROM qualified_leads GROUP BY status");
    const byStatus: Record<string, number> = {}; let total = 0;
    rows.forEach(r => { byStatus[String(r.status)] = Number(r.cnt); total += Number(r.cnt); });
    return { total, byStatus };
  } finally { conn.release(); }
}
export async function insertQualifiedLead(l: QualifiedLead) {
  // Guard: WA tidak aktif / belum terverifikasi tidak boleh masuk qualified
  if (!l.waVerified) return;
  const conn = await getConn();
  try {
    await conn.query(
      `INSERT INTO qualified_leads (id, place_id, name, company, address, phone_628, city, category, rating, review_count, website, maps_url, score, wa_verified, message, message_variants, status, created_at, contacted_at, replied_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE score=VALUES(score), message=VALUES(message), address=VALUES(address), maps_url=VALUES(maps_url)`,
      [l.id, l.placeId, l.name, l.company ?? "", l.address ?? null, l.phone628, l.city ?? "", l.category ?? "", l.rating ?? null, l.reviewCount, l.website ?? "", l.mapsUrl ?? "", l.score, l.waVerified ? 1 : 0, l.message ?? null, l.messageVariants ? JSON.stringify(l.messageVariants) : null, l.status, toMysql(l.createdAt), toMysql(l.contactedAt), toMysql(l.repliedAt)]
    );
  } finally { conn.release(); }
}
export async function updateQualifiedLead(id: string, patch: Partial<QualifiedLead>) {
  const conn = await getConn();
  try {
    const cur = await getQualifiedLead(id);
    if (!cur) return undefined;
    const m = { ...cur, ...patch };
    await conn.query(
      `UPDATE qualified_leads SET name=?, company=?, address=?, phone_628=?, city=?, category=?, rating=?, review_count=?, website=?, maps_url=?, score=?, wa_verified=?, message=?, message_variants=?, status=?, contacted_at=?, replied_at=? WHERE id=?`,
      [m.name, m.company ?? "", m.address ?? null, m.phone628, m.city ?? "", m.category ?? "", m.rating ?? null, m.reviewCount, m.website ?? "", m.mapsUrl ?? "", m.score, m.waVerified ? 1 : 0, m.message ?? null, m.messageVariants ? JSON.stringify(m.messageVariants) : null, m.status, toMysql(m.contactedAt), toMysql(m.repliedAt), id]
    );
    return m;
  } finally { conn.release(); }
}
export async function findQualifiedByPhone(phone628: string) {
  const conn = await getConn();
  try { const [rows] = await conn.query<QualifiedLeadRow[]>("SELECT * FROM qualified_leads WHERE phone_628=? LIMIT 1", [phone628]); return rows.length ? rowToQualifiedLead(rows[0]) : undefined; } finally { conn.release(); }
}

// Antrian tunda verifikasi WA (gateway error/timeout -> null): dicoba lagi di run berikutnya / manual.
export interface WaPendingRow { place_id: string; phone_628: string; name: string; city: string; category: string; attempts: number; next_retry_at: string; created_at: string; }
export async function upsertWaPending(p: { placeId: string; phone628: string; name?: string; city?: string; category?: string }) {
  const conn = await getConn();
  try {
    const now = todayISO();
    const next = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await conn.query(
      `INSERT INTO wa_verify_pending (place_id, phone_628, name, city, category, attempts, next_retry_at, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)
       ON DUPLICATE KEY UPDATE phone_628=VALUES(phone_628), attempts=attempts+1, next_retry_at=VALUES(next_retry_at)`,
      [p.placeId, p.phone628, p.name ?? "", p.city ?? "", p.category ?? "", toMysql(next), toMysql(now)]
    );
  } finally { conn.release(); }
}
export async function getDueWaPending(limit = 20) {
  const conn = await getConn();
  try {
    const [rows] = await conn.query<(WaPendingRow & RowDataPacket)[]>(
      "SELECT * FROM wa_verify_pending WHERE next_retry_at <= NOW(3) ORDER BY next_retry_at ASC LIMIT " + Math.min(Math.max(Number(limit) || 20, 1), 100)
    );
    return rows;
  } finally { conn.release(); }
}
export async function deleteWaPending(placeId: string) {
  const conn = await getConn();
  try { await conn.query("DELETE FROM wa_verify_pending WHERE place_id=?", [placeId]); } finally { conn.release(); }
}
export async function countWaPending() {
  const conn = await getConn();
  try { const [r] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) total FROM wa_verify_pending"); return Number(r[0]?.total ?? 0); } finally { conn.release(); }
}
// Reset total outreach: kosongkan raw + qualified + pending + counter + webhook,
// lalu kembalikan SEMUA search_targets ke PENDING (attempts=0).
export async function resetOutreachData(): Promise<{ raw: number; qualified: number; pending: number; targets: { total: number; byStatus: Record<string, number> } }> {
  const conn = await getConn();
  try {
    const [rawRows] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) total FROM raw_leads");
    const [qRows] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) total FROM qualified_leads");
    const [pRows] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) total FROM wa_verify_pending");
    const raw = Number(rawRows[0]?.total ?? 0);
    const qualified = Number(qRows[0]?.total ?? 0);
    const pending = Number(pRows[0]?.total ?? 0);
    await conn.query("DELETE FROM qualified_leads");
    await conn.query("DELETE FROM raw_leads");
    await conn.query("DELETE FROM wa_verify_pending");
    await conn.query("DELETE FROM webhook_logs");
    await conn.query("DELETE FROM outreach_daily_counter");
    await conn.query("UPDATE search_targets SET status='PENDING', attempts=0, last_error=NULL, updated_at=?", [toMysql(todayISO())]);
    const [tRows] = await conn.query<RowDataPacket[]>("SELECT status, COUNT(*) cnt FROM search_targets GROUP BY status");
    const byStatus: Record<string, number> = {}; let total = 0;
    tRows.forEach(r => { byStatus[String(r.status)] = Number(r.cnt); total += Number(r.cnt); });
    return { raw, qualified, pending, targets: { total, byStatus } };
  } finally { conn.release(); }
}
// Arsip satu-kali: pindahkan qualified lama yang wa_verified=0 ke pending, lalu hapus dari qualified.
export async function archiveUnverifiedQualified(): Promise<{ archived: number }> {
  const conn = await getConn();
  try {
    const [rows] = await conn.query<QualifiedLeadRow[]>("SELECT * FROM qualified_leads WHERE wa_verified=0");
    let archived = 0;
    for (const r of rows) {
      const ql = rowToQualifiedLead(r);
      await upsertWaPending({ placeId: ql.placeId, phone628: ql.phone628, name: ql.name, city: ql.city, category: ql.category });
      await conn.query("DELETE FROM qualified_leads WHERE id=?", [ql.id]);
      archived++;
    }
    return { archived };
  } finally { conn.release(); }
}

export async function insertWebhookLog(phone628: string, event: string, payload: unknown) {
  const conn = await getConn();
  try { await conn.query("INSERT INTO webhook_logs (id, phone_628, event, payload, created_at) VALUES (?, ?, ?, ?, ?)", [uid("wh_"), phone628, event, payload ? JSON.stringify(payload) : null, toMysql(todayISO())]); } finally { conn.release(); }
}

export async function getDailyCount(dateStr: string): Promise<number> {
  const conn = await getConn();
  try { const [rows] = await conn.query<RowDataPacket[]>("SELECT count FROM outreach_daily_counter WHERE date=?", [dateStr]); return rows.length ? Number(rows[0].count) : 0; } finally { conn.release(); }
}
export async function incrDailyCount(dateStr: string): Promise<number> {
  const conn = await getConn();
  try {
    await conn.query("INSERT INTO outreach_daily_counter (date, count) VALUES (?, 1) ON DUPLICATE KEY UPDATE count=count+1", [dateStr]);
    const [rows] = await conn.query<RowDataPacket[]>("SELECT count FROM outreach_daily_counter WHERE date=?", [dateStr]);
    return Number(rows[0]?.count ?? 0);
  } finally { conn.release(); }
}
// Kuota harian DeepSeek real: dihitung per tanggal WIB, increment hanya saat AI sukses.
export async function getDeepseekDailyCount(dateStr: string): Promise<number> {
  const conn = await getConn();
  try { const [rows] = await conn.query<RowDataPacket[]>("SELECT count FROM deepseek_daily_counter WHERE date=?", [dateStr]); return rows.length ? Number(rows[0].count) : 0; } finally { conn.release(); }
}
export async function incrDeepseekDailyCount(dateStr: string): Promise<number> {
  const conn = await getConn();
  try {
    await conn.query("INSERT INTO deepseek_daily_counter (date, count) VALUES (?, 1) ON DUPLICATE KEY UPDATE count=count+1", [dateStr]);
    const [rows] = await conn.query<RowDataPacket[]>("SELECT count FROM deepseek_daily_counter WHERE date=?", [dateStr]);
    return Number(rows[0]?.count ?? 0);
  } finally { conn.release(); }
}
export async function getOutreachStats() {
  const [qCount, qBy, rawTotal, targetCount] = await Promise.all([countQualifiedLeads(), countQualifiedLeads(), countRawLeads(), countSearchTargets()]);
  // qBy duplicate call intentional above, fix: reuse
  void qCount;
  const q = await countQualifiedLeads();
  const t = await countSearchTargets();
  const r = await countRawLeads();
  return { qualified: q, targets: t, rawLeads: r };
}

/* ================= Jobs app helpers (isolasi penuh) ================= */

import type { JobListing, JobRaw, JobSource, JobTarget } from "./types";

interface JobTargetRow extends RowDataPacket {
  id: string; keyword: string; source: JobSource; status: JobTarget["status"];
  attempts: number; last_error: string | null; created_at: string; updated_at: string;
}
function rowToJobTarget(r: JobTargetRow): JobTarget {
  return {
    id: r.id, keyword: r.keyword, source: r.source, status: r.status,
    attempts: Number(r.attempts), lastError: r.last_error ?? undefined,
    createdAt: fromMysql(r.created_at) ?? todayISO(), updatedAt: fromMysql(r.updated_at) ?? todayISO(),
  };
}
export async function getJobTargets(opts: { status?: string; source?: string; limit?: number; offset?: number } = {}) {
  const conn = await getConn();
  try {
    const where: string[] = []; const params: unknown[] = [];
    if (opts.status) { where.push("status = ?"); params.push(opts.status); }
    if (opts.source) { where.push("source = ?"); params.push(opts.source); }
    const lim = Math.min(Math.max(Math.floor(Number(opts.limit) || 100), 1), 500);
    const off = Math.max(Math.floor(Number(opts.offset) || 0), 0);
    const sql = "SELECT * FROM job_targets" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY created_at ASC LIMIT " + lim + " OFFSET " + off;
    const [rows] = await conn.query<JobTargetRow[]>(sql, params);
    return rows.map(rowToJobTarget);
  } finally { conn.release(); }
}
export async function countJobTargets() {
  const conn = await getConn();
  try {
    const [rows] = await conn.query<RowDataPacket[]>("SELECT status, COUNT(*) cnt FROM job_targets GROUP BY status");
    const byStatus: Record<string, number> = {}; let total = 0;
    rows.forEach((r) => { byStatus[String(r.status)] = Number(r.cnt); total += Number(r.cnt); });
    return { total, byStatus };
  } finally { conn.release(); }
}
export async function insertJobTarget(t: JobTarget) {
  const conn = await getConn();
  try {
    await conn.query(
      "INSERT INTO job_targets (id, keyword, source, status, attempts, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE updated_at=VALUES(updated_at)",
      [t.id, t.keyword, t.source, t.status, t.attempts, t.lastError ?? null, toMysql(t.createdAt), toMysql(t.updatedAt)]
    );
  } finally { conn.release(); }
}
export async function updateJobTarget(id: string, patch: Partial<JobTarget>) {
  const conn = await getConn();
  try {
    const sets: string[] = []; const params: unknown[] = [];
    if (patch.status) { sets.push("status = ?"); params.push(patch.status); }
    if (patch.attempts !== undefined) { sets.push("attempts = ?"); params.push(patch.attempts); }
    if (patch.lastError !== undefined) { sets.push("last_error = ?"); params.push(patch.lastError); }
    sets.push("updated_at = ?"); params.push(toMysql(todayISO()));
    params.push(id);
    await conn.query(`UPDATE job_targets SET ${sets.join(", ")} WHERE id = ?`, params);
  } finally { conn.release(); }
}
export async function claimNextJobTarget(): Promise<JobTarget | undefined> {
  const conn = await getConn();
  try {
    await conn.query("START TRANSACTION");
    const [rows] = await conn.query<JobTargetRow[]>(
      "SELECT * FROM job_targets WHERE status='PENDING' ORDER BY created_at ASC LIMIT 1 FOR UPDATE"
    );
    if (!rows.length) { await conn.query("COMMIT"); return undefined; }
    const t = rows[0];
    await conn.query("UPDATE job_targets SET status='PROCESSING', attempts=attempts+1, updated_at=? WHERE id=?", [toMysql(todayISO()), t.id]);
    await conn.query("COMMIT");
    return rowToJobTarget({ ...t, status: "PROCESSING", attempts: Number(t.attempts) + 1 });
  } catch {
    try { await conn.query("ROLLBACK"); } catch {}
    return undefined;
  } finally { conn.release(); }
}
export async function retryFailedJobTargets(): Promise<{ retried: number }> {
  const conn = await getConn();
  try {
    const [r] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) total FROM job_targets WHERE status='FAILED'");
    const retried = Number(r[0]?.total ?? 0);
    await conn.query("UPDATE job_targets SET status='PENDING', last_error=NULL, updated_at=? WHERE status='FAILED'", [toMysql(todayISO())]);
    return { retried };
  } finally { conn.release(); }
}

interface JobRawRow extends RowDataPacket {
  id: string; source: JobSource; external_id: string; title: string; company: string;
  location: string; url: string; posted_date: string | null; payload: string | unknown;
  reason_skipped: string; created_at: string; last_seen_at: string;
}
function rowToJobRaw(r: JobRawRow): JobRaw {
  return {
    id: r.id, source: r.source, externalId: r.external_id, title: r.title, company: r.company,
    location: r.location, url: r.url, postedDate: fromMysql(r.posted_date ?? undefined),
    payload: parseJson(r.payload, undefined), reasonSkipped: r.reason_skipped || undefined,
    createdAt: fromMysql(r.created_at) ?? todayISO(), lastSeenAt: fromMysql(r.last_seen_at) ?? todayISO(),
  };
}
export function normalizeJobUrl(u: string): string {
  try {
    const url = new URL(u);
    url.search = ""; url.hash = "";
    return url.toString().toLowerCase().replace(/\/+$/, "");
  } catch { return u.trim().toLowerCase(); }
}
export async function upsertJobRaw(j: JobRaw) {
  const conn = await getConn();
  try {
    const normUrl = normalizeJobUrl(j.url);
    await conn.query(
      `INSERT INTO job_raw (id, source, external_id, title, company, location, url, posted_date, payload, reason_skipped, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE last_seen_at=VALUES(last_seen_at), title=VALUES(title), company=VALUES(company), payload=VALUES(payload), reason_skipped=VALUES(reason_skipped)`,
      [j.id, j.source, j.externalId, j.title, j.company, j.location, normUrl, toMysql(j.postedDate), j.payload ? JSON.stringify(j.payload) : null, j.reasonSkipped ?? "", toMysql(j.createdAt), toMysql(j.lastSeenAt)]
    );
  } finally { conn.release(); }
}
export async function getJobRaw(opts: { source?: string; limit?: number; offset?: number } = {}) {
  const conn = await getConn();
  try {
    const where: string[] = []; const params: unknown[] = [];
    if (opts.source) { where.push("source = ?"); params.push(opts.source); }
    const lim = Math.min(Math.max(Math.floor(Number(opts.limit) || 50), 1), 500);
    const off = Math.max(Math.floor(Number(opts.offset) || 0), 0);
    const sql = "SELECT * FROM job_raw" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY last_seen_at DESC LIMIT " + lim + " OFFSET " + off;
    const [rows] = await conn.query<JobRawRow[]>(sql, params);
    return rows.map(rowToJobRaw);
  } finally { conn.release(); }
}
export async function countJobRaw() {
  const conn = await getConn();
  try { const [r] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) total FROM job_raw"); return Number(r[0]?.total ?? 0); }
  finally { conn.release(); }
}

interface JobListingRow extends RowDataPacket {
  id: string; source: JobSource; external_id: string; title: string; company: string;
  location: string; url: string; salary_text: string; remote_label: JobListing["remoteLabel"];
  review_flag: number; score: number; status: JobListing["status"]; hidden: number;
  posted_date: string | null; first_seen_at: string; last_seen_at: string; created_at: string;
}
function rowToJobListing(r: JobListingRow): JobListing {
  return {
    id: r.id, source: r.source, externalId: r.external_id, title: r.title, company: r.company,
    location: r.location, url: r.url, salaryText: r.salary_text || undefined,
    remoteLabel: r.remote_label, reviewFlag: Boolean(r.review_flag), score: Number(r.score),
    status: r.status, hidden: Boolean(r.hidden), postedDate: fromMysql(r.posted_date ?? undefined),
    firstSeenAt: fromMysql(r.first_seen_at) ?? todayISO(), lastSeenAt: fromMysql(r.last_seen_at) ?? todayISO(),
    createdAt: fromMysql(r.created_at) ?? todayISO(),
  };
}
export async function upsertJobListing(l: JobListing) {
  const conn = await getConn();
  try {
    const normUrl = normalizeJobUrl(l.url);
    await conn.query(
      `INSERT INTO job_listings (id, source, external_id, title, company, location, url, salary_text, remote_label, review_flag, score, status, hidden, posted_date, first_seen_at, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE last_seen_at=VALUES(last_seen_at), title=VALUES(title), company=VALUES(company), salary_text=VALUES(salary_text), remote_label=VALUES(remote_label), review_flag=VALUES(review_flag), score=VALUES(score), posted_date=VALUES(posted_date)`,
      [l.id, l.source, l.externalId, l.title, l.company, l.location, normUrl, l.salaryText ?? "", l.remoteLabel, l.reviewFlag ? 1 : 0, l.score, l.status, l.hidden ? 1 : 0, toMysql(l.postedDate), toMysql(l.firstSeenAt), toMysql(l.lastSeenAt), toMysql(l.createdAt)]
    );
  } finally { conn.release(); }
}
export async function getJobListings(opts: { status?: string; source?: string; includeHidden?: boolean; limit?: number; offset?: number } = {}) {
  const conn = await getConn();
  try {
    const where: string[] = []; const params: unknown[] = [];
    if (opts.status) { where.push("status = ?"); params.push(opts.status); }
    if (opts.source) { where.push("source = ?"); params.push(opts.source); }
    if (!opts.includeHidden) { where.push("hidden = 0"); }
    const lim = Math.min(Math.max(Math.floor(Number(opts.limit) || 100), 1), 500);
    const off = Math.max(Math.floor(Number(opts.offset) || 0), 0);
    const sql = "SELECT * FROM job_listings" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY score DESC, posted_date DESC LIMIT " + lim + " OFFSET " + off;
    const [rows] = await conn.query<JobListingRow[]>(sql, params);
    return rows.map(rowToJobListing);
  } finally { conn.release(); }
}
export async function countJobListingsFiltered(opts: { status?: string; includeHidden?: boolean } = {}) {
  const conn = await getConn();
  try {
    const where: string[] = []; const params: unknown[] = [];
    if (opts.status) { where.push("status = ?"); params.push(opts.status); }
    if (!opts.includeHidden) { where.push("hidden = 0"); }
    const sql = "SELECT COUNT(*) total FROM job_listings" + (where.length ? " WHERE " + where.join(" AND ") : "");
    const [r] = await conn.query<RowDataPacket[]>(sql, params);
    return Number(r[0]?.total ?? 0);
  } finally { conn.release(); }
}
export async function countJobListings() {
  const conn = await getConn();
  try {
    const [rows] = await conn.query<RowDataPacket[]>("SELECT status, COUNT(*) cnt FROM job_listings WHERE hidden=0 GROUP BY status");
    const byStatus: Record<string, number> = {}; let total = 0;
    rows.forEach((r) => { byStatus[String(r.status)] = Number(r.cnt); total += Number(r.cnt); });
    const [h] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) total FROM job_listings WHERE hidden=1");
    return { total, byStatus, hidden: Number(h[0]?.total ?? 0) };
  } finally { conn.release(); }
}
export async function getJobListing(id: string) {
  const conn = await getConn();
  try { const [rows] = await conn.query<JobListingRow[]>("SELECT * FROM job_listings WHERE id = ?", [id]); return rows.length ? rowToJobListing(rows[0]) : undefined; }
  finally { conn.release(); }
}
export async function updateJobListing(id: string, patch: Partial<JobListing>) {
  const conn = await getConn();
  try {
    const cur = await getJobListing(id);
    if (!cur) return undefined;
    const m = { ...cur, ...patch };
    await conn.query(
      `UPDATE job_listings SET title=?, company=?, location=?, url=?, salary_text=?, remote_label=?, review_flag=?, score=?, status=?, hidden=?, posted_date=?, last_seen_at=? WHERE id=?`,
      [m.title, m.company, m.location, normalizeJobUrl(m.url), m.salaryText ?? "", m.remoteLabel, m.reviewFlag ? 1 : 0, m.score, m.status, m.hidden ? 1 : 0, toMysql(m.postedDate), toMysql(m.lastSeenAt), id]
    );
    return m;
  } finally { conn.release(); }
}
export async function deleteJobListingPermanent(id: string): Promise<boolean> {
  const conn = await getConn();
  try {
    const [r] = await conn.query<ResultSetHeader>("DELETE FROM job_listings WHERE id = ?", [id]);
    return r.affectedRows > 0;
  } finally { conn.release(); }
}
// Kosongkan Sampah: hanya baris hidden=1. Tidak sentuh list utama / job_raw / targets.
export async function deleteTrashJobListings(): Promise<{ removed: number }> {
  const conn = await getConn();
  try {
    const [r] = await conn.query<ResultSetHeader>("DELETE FROM job_listings WHERE hidden = 1");
    return { removed: r.affectedRows ?? 0 };
  } finally { conn.release(); }
}
export async function findJobListingFuzzy(title: string, company: string): Promise<JobListing | undefined> {
  const conn = await getConn();
  try {
    const [rows] = await conn.query<JobListingRow[]>(
      "SELECT * FROM job_listings WHERE LOWER(title)=LOWER(?) AND LOWER(company)=LOWER(?) AND last_seen_at >= DATE_SUB(NOW(3), INTERVAL 30 DAY) LIMIT 1",
      [title, company]
    );
    return rows.length ? rowToJobListing(rows[0]) : undefined;
  } finally { conn.release(); }
}
export async function resetJobsData() {
  const conn = await getConn();
  try {
    const [r1] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) total FROM job_raw");
    const [r2] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) total FROM job_listings");
    await conn.query("DELETE FROM job_listings");
    await conn.query("DELETE FROM job_raw");
    await conn.query("UPDATE job_targets SET status='PENDING', attempts=0, last_error=NULL, updated_at=?", [toMysql(todayISO())]);
    const t = await countJobTargets();
    return { raw: Number(r1[0]?.total ?? 0), listings: Number(r2[0]?.total ?? 0), targets: t };
  } finally { conn.release(); }
}