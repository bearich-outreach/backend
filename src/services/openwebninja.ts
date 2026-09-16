// Adapter OpenWebNinja Remote Jobs API (JSearch search-v2) -> ScrapedJob.
// Sumber ke-4 Job Hunter (global remote), terpisah dari scrape Playwright.
// Kode defensif: base URL + param via env, toleran terhadap variasi respons.
// Tanpa API key -> throw error jelas (worker menangkap -> FAILED, bukan crash).

import type { ScrapedJob, WorkArrangement } from "./jobScrape";

interface OwnHighlight {
  Qualifications?: string[];
  Responsibilities?: string[];
  Benefits?: string[];
}

interface OwnJob {
  job_id?: string;
  job_title?: string;
  employer_name?: string;
  job_location?: string;
  job_city?: string;
  job_country?: string;
  job_apply_link?: string;
  job_description?: string;
  job_is_remote?: boolean;
  job_posted_at_timestamp?: number;
  job_posted_at_datetime_utc?: string;
  job_min_salary?: number | null;
  job_max_salary?: number | null;
  job_salary_period?: string | null;
  job_employment_type?: string | null;
  job_highlights?: OwnHighlight | null;
}

export function ownBaseUrl(): string {
  return (process.env.OWN_BASE_URL || "https://api.openwebninja.com/jsearch/search-v2").replace(/\/+$/, "");
}

export function ownApiKey(): string {
  return (process.env.OPENWEBNINJA_API_KEY || "").trim();
}

function salaryText(j: OwnJob): string {
  const min = Number(j.job_min_salary);
  const max = Number(j.job_max_salary);
  if (Number.isFinite(min) && Number.isFinite(max) && (min > 0 || max > 0)) {
    const period = j.job_salary_period ? `/${String(j.job_salary_period).toLowerCase()}` : "";
    return `${min}-${max}${period}`;
  }
  if (Number.isFinite(min) && min > 0) return `${min}`;
  if (Number.isFinite(max) && max > 0) return `up to ${max}`;
  return "";
}

function postedDate(j: OwnJob): string | undefined {
  const ts = Number(j.job_posted_at_timestamp);
  if (Number.isFinite(ts) && ts > 0) {
    // API memakai detik unix (10 digit); normalisasi bila milidetik.
    const ms = ts < 1e12 ? ts * 1000 : ts;
    const d = new Date(ms);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  if (j.job_posted_at_datetime_utc) {
    const d = new Date(j.job_posted_at_datetime_utc);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return undefined;
}

function arrangementOf(j: OwnJob): WorkArrangement {
  if (j.job_is_remote === true) return "REMOTE";
  const text = `${j.job_title ?? ""} ${j.job_description ?? ""}`.toLowerCase();
  if (/hybrid|hibrid/.test(text)) return "HYBRID";
  if (/onsite|on-site|on site|\bwfo\b/.test(text)) return "ONSITE";
  if (/\bremote\b|\bwfh\b|work from home/.test(text)) return "REMOTE";
  return "UNKNOWN";
}

/** Kualifikasi di depan (paling padat skill) lalu deskripsi — untuk Top Skills. */
export function buildSnippet(j: OwnJob, maxLen = 2000): string {
  const quals = Array.isArray(j.job_highlights?.Qualifications)
    ? j.job_highlights.Qualifications.join(" ")
    : "";
  const desc = j.job_description ?? "";
  return `${quals}\n${desc}`.trim().slice(0, maxLen);
}

export function mapOwnJob(j: OwnJob): ScrapedJob | null {
  const id = String(j.job_id ?? "").trim();
  const title = String(j.job_title ?? "").trim();
  if (!id || !title) return null;
  const location =
    String(j.job_location ?? "").trim() ||
    [j.job_city, j.job_country].filter(Boolean).join(", ");
  return {
    externalId: `own-${id}`,
    title: title.slice(0, 255),
    company: String(j.employer_name ?? "").trim().slice(0, 255) || "Unknown",
    location: location.slice(0, 255),
    url: String(j.job_apply_link ?? "").trim(),
    salaryText: salaryText(j),
    description: buildSnippet(j),
    postedDate: postedDate(j),
    workArrangement: arrangementOf(j),
    verifiedDetail: true, // data API sudah terstruktur, setara verifikasi detail
  };
}

/** Ambil array lowongan dari berbagai bentuk respons API (tahan variasi). */
export function extractJobList(body: unknown): OwnJob[] {
  if (Array.isArray(body)) return body as OwnJob[];
  if (!body || typeof body !== "object") return [];
  const o = body as Record<string, unknown>;
  // Bentuk nyata API: { status, request_id, parameters, data: { jobs: [...] } }
  if (o.data && typeof o.data === "object" && !Array.isArray(o.data)) {
    const inner = o.data as Record<string, unknown>;
    if (Array.isArray(inner.jobs)) return inner.jobs as OwnJob[];
    if (Array.isArray(inner.data)) return inner.data as OwnJob[];
    if (Array.isArray(inner.results)) return inner.results as OwnJob[];
  }
  if (Array.isArray(o.data)) return o.data as OwnJob[];
  if (Array.isArray(o.jobs)) return o.jobs as OwnJob[];
  if (Array.isArray(o.results)) return o.results as OwnJob[];
  // Fallback terakhir: array pertama 1 level ke dalam yang anggotanya mirip job.
  for (const v of Object.values(o)) {
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object" && v[0] !== null) {
      const first = v[0] as Record<string, unknown>;
      if ("job_id" in first || "job_title" in first) return v as OwnJob[];
    }
  }
  return [];
}

export interface OwnSearchResult {
  jobs: ScrapedJob[];
  rawCount: number;
}

/**
 * Satu query = satu request API (hemat kuota free tier 200/bln).
 * num_pages param via env OWN_PAGES (default 1). Throw bila key kosong / HTTP gagal.
 */
export async function searchOwnJobs(query: string): Promise<OwnSearchResult> {
  const key = ownApiKey();
  if (!key) throw new Error("OPENWEBNINJA_API_KEY belum diisi");
  const pages = Math.min(Math.max(Math.floor(Number(process.env.OWN_PAGES) || 1), 1), 5);
  const url = `${ownBaseUrl()}?${new URLSearchParams({
    query,
    num_pages: String(pages),
  })}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, {
      headers: { "x-api-key": key },
      signal: ctrl.signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error("openwebninja: API key ditolak (401/403)");
    }
    if (res.status === 429) {
      throw new Error("openwebninja: rate limit (429) — kuota habis, coba besok");
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`openwebninja: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as unknown;
    const list = extractJobList(data);
    console.log(`[own] query="${query}" raw=${list.length}`);
    const jobs: ScrapedJob[] = [];
    for (const j of list) {
      // Cap per query agar 1 request tidak membanjiri buffer.
      if (jobs.length >= 15) break;
      const m = mapOwnJob(j);
      if (m && m.url) jobs.push(m);
    }
    if (list.length > 0 && jobs.length === 0) {
      console.log(`[own] query="${query}" peringatan: ${list.length} hasil tapi 0 ter-mapping (cek judul/url kosong)`);
    }
    return { jobs, rawCount: list.length };
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error("openwebninja: timeout 30s");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
