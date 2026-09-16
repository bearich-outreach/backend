import crypto from "crypto";
import {
  claimNextJobTarget,
  claimRecycledJobTarget,
  updateJobTarget,
  upsertJobRaw,
  upsertJobListing,
  findJobListingFuzzy,
  normalizeJobUrl,
  ownDailyBudget,
  getOwnDailyCount,
  incrOwnDailyCount,
} from "../db";
import { searchOwnJobs, ownApiKey } from "../services/openwebninja";
import { scoreJob, detectRemoteLabel } from "../services/jobScoring";
import { uid, todayISO } from "../store";

function hash(s: string) { return crypto.createHash("md5").update(s).digest("hex").slice(0, 16); }

function todayWIB(): string {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" })).toISOString().slice(0, 10);
}

export interface OwnRunResult {
  keyword?: string;
  rawCount?: number;
  listingCount?: number;
  skippedNonRemote?: number;
  noKey?: boolean;
  quotaExceeded?: boolean;
  usedToday?: number;
  budget?: number;
  recycled?: boolean;
  noEligible?: boolean;
  captcha?: boolean;
}

/**
 * Worker harian OpenWebNinja: 1 target per run, quota guard ketat (free 200/bln).
 * Alur sama persis dengan worker Playwright (gate remote -> dedup fuzzy -> listings),
 * tanpa filter/routing lokasi khusus — seadanya mengikuti sistem yang berjalan.
 */
export async function processNextOwnTarget(): Promise<OwnRunResult> {
  if (!ownApiKey()) return { noKey: true };
  const budget = ownDailyBudget();
  const day = todayWIB();
  const used = await getOwnDailyCount(day);
  if (used >= budget) {
    return { quotaExceeded: true, usedToday: used, budget };
  }
  let target = await claimNextJobTarget("openwebninja");
  let recycled = false;
  if (!target) {
    target = await claimRecycledJobTarget("openwebninja");
    recycled = Boolean(target);
  }
  if (!target) return { noEligible: true, usedToday: used, budget };
  try {
    const { jobs } = await searchOwnJobs(target.keyword);
    await incrOwnDailyCount(day);
    const now = todayISO();
    let listings = 0, skippedNonRemote = 0;
    for (const s of jobs) {
      const normUrl = normalizeJobUrl(s.url, target.source);
      const extId = s.externalId || `job-${hash(normUrl)}`;
      const arrangement = s.workArrangement ?? "UNKNOWN";
      // Gate keras non-remote — sama seperti worker Playwright.
      const cardReject = arrangement === "ONSITE" || arrangement === "HYBRID";
      const { label, reviewFlag } = detectRemoteLabel(s.location, `${s.description ?? ""} ${s.title}`);
      const isRemote = !cardReject && label === "Remote" && !reviewFlag;
      const location = s.location || (isRemote ? "Remote" : "Tidak diketahui");
      const reasonSkipped = isRemote
        ? ""
        : `non-remote: arrangement=${arrangement} label=${label} loc=${location} (verified-detail)`;
      await upsertJobRaw({
        id: uid("jr_"), source: target.source, externalId: extId,
        title: s.title, company: s.company, location, url: normUrl, clickUrl: s.url,
        postedDate: s.postedDate,
        payload: { keyword: target.keyword, salaryText: s.salaryText, description: (s.description ?? "").slice(0, 2000), workArrangement: arrangement, verifiedDetail: s.verifiedDetail ?? false, remoteLabel: label },
        reasonSkipped, createdAt: now, lastSeenAt: now,
      });
      if (!isRemote) { skippedNonRemote++; continue; }
      const dup = s.company ? await findJobListingFuzzy(s.title, s.company) : undefined;
      if (dup) continue;
      const score = scoreJob({ title: s.title, description: s.description, postedDate: s.postedDate });
      await upsertJobListing({
        id: uid("jl_"), source: target.source, externalId: extId,
        title: s.title || target.keyword, company: s.company || "Unknown",
        location, url: normUrl, clickUrl: s.url, salaryText: s.salaryText,
        descriptionSnippet: (s.description ?? "").slice(0, 2000) || undefined,
        remoteLabel: label, reviewFlag, score, status: "New",
        hidden: false, postedDate: s.postedDate, firstSeenAt: now, lastSeenAt: now, createdAt: now,
      });
      listings++;
    }
    await updateJobTarget(target.id, { status: "DONE" });
    return { keyword: target.keyword, rawCount: jobs.length, listingCount: listings, skippedNonRemote, usedToday: used + 1, budget, recycled };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[own] gagal keyword="${target.keyword}" err=${msg.slice(0, 300)}`);
    const quota = /429|rate limit|kuota/i.test(msg);
    await updateJobTarget(target.id, { status: "FAILED", lastError: msg.slice(0, 500) });
    return { keyword: target.keyword, quotaExceeded: quota || undefined, usedToday: used, budget };
  }
}

/** Dipanggil cron harian: proses 1 target per hari (hemat kuota). */
export async function ensureOwnDaily(): Promise<void> {
  if (!ownApiKey()) return; // tanpa key -> skip diam-diam sebelum sentuh DB
  const day = todayWIB();
  if ((await getOwnDailyCount(day)) >= ownDailyBudget()) return;
  await processNextOwnTarget();
}
