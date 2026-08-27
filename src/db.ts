import {
  createPool,
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import {
  Activity,
  Prospect,
  ProspectStatus,
  SequenceStep,
  Settings,
} from "./types";
import { todayISO, uid } from "./store";

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

    const [existing] = await conn.query<RowDataPacket[]>(
      "SELECT id FROM settings WHERE id = 1"
    );
    if (existing.length === 0) {
      await conn.query(
        "INSERT IGNORE INTO settings (id, services, sequence) VALUES (1, ?, ?)",
        [JSON.stringify(DEFAULTS.services), JSON.stringify(DEFAULTS.sequence)]
      );
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