import crypto from "crypto";
import {
  claimNextJobTarget, peekNextJobTarget, updateJobTarget, upsertJobRaw, upsertJobListing,
  findJobListingFuzzy, getJobListings, normalizeJobUrl,
} from "../db";
import { scrapeJobs } from "../services/jobScrape";
import { scoreJob, detectRemoteLabel } from "../services/jobScoring";
import type { JobSource } from "../types";
import { uid, todayISO } from "../store";

function hash(s: string) { return crypto.createHash("md5").update(s).digest("hex").slice(0, 16); }

// Pacing per source (in-memory): JobStreet yang memblokir bot hanya boleh dicoba
// ~1x/jam, Glints tetap tiap tick 15 mnt. Berlaku untuk cron maupun tombol manual
// karena keduanya lewat processNextJobTarget. Restart proses me-reset timer
// (efek terburuk: 1 hit ekstra setelah deploy — dapat diterima).
let lastJobstreetRunAt = 0;
function jobstreetMinIntervalMs(): number {
  const v = Number(process.env.JOBS_JOBSTREET_MIN_INTERVAL_MS ?? 3600000);
  return Number.isFinite(v) && v >= 0 ? v : 3600000;
}
function isJobstreetThrottled(): boolean {
  return Date.now() - lastJobstreetRunAt < jobstreetMinIntervalMs();
}

export async function processNextJobTarget(): Promise<{ keyword?: string; source?: string; rawCount?: number; listingCount?: number; skippedNonRemote?: number; throttled?: boolean; captcha?: boolean }> {
  // Keputusan pacing SEBELUM klaim (klaim menaikkan attempts — jangan klaim yang
  // akan dibuang). Bila antrean terdepan JobStreet tapi sedang di-throttle,
  // isi slot dengan Glints agar sumber sehat tidak ikut kelaparan.
  const next = await peekNextJobTarget();
  if (!next) return {};
  let sourceFilter: JobSource | undefined;
  if (next.source === "jobstreet" && isJobstreetThrottled()) sourceFilter = "glints";
  const target = await claimNextJobTarget(sourceFilter);
  if (!target) return { throttled: Boolean(sourceFilter), source: sourceFilter ?? next.source };
  if (target.source === "jobstreet") lastJobstreetRunAt = Date.now();
  try {
    const scraped = await scrapeJobs(target.keyword, target.source);
    if (scraped.length === 0 && process.env.USE_PLAYWRIGHT === "true") {
      await updateJobTarget(target.id, { status: "FAILED", lastError: "tidak ada hasil (kemungkinan throttling/block, bisa retry)" });
      return { keyword: target.keyword, source: target.source, rawCount: 0, listingCount: 0 };
    }
    const now = todayISO();
    let listings = 0, skippedNonRemote = 0;
    for (const s of scraped) {
      const normUrl = normalizeJobUrl(s.url);
      const extId = s.externalId || `job-${hash(normUrl)}`;
      const arrangement = s.workArrangement ?? "UNKNOWN";
      // Gate keras non-remote: ONSITE/HYBRID dari kartu/detail langsung dibuang
      // (tetap tercatat di job_raw untuk audit). Data lama tidak disentuh.
      const cardReject = arrangement === "ONSITE" || arrangement === "HYBRID";
      const { label, reviewFlag } = detectRemoteLabel(s.location, `${s.description ?? ""} ${s.title}`);
      const isRemote = !cardReject && label === "Remote" && !reviewFlag;
      const location = s.location || (isRemote ? "Remote" : "Tidak diketahui");
      const reasonSkipped = isRemote
        ? ""
        : `non-remote: arrangement=${arrangement} label=${label} loc=${location}${s.verifiedDetail ? " (verified-detail)" : " (card-only)"}`;
      await upsertJobRaw({
        id: uid("jr_"), source: target.source, externalId: extId,
        title: s.title, company: s.company, location, url: normUrl,
        postedDate: s.postedDate,
        payload: { keyword: target.keyword, salaryText: s.salaryText, workArrangement: arrangement, verifiedDetail: s.verifiedDetail ?? false, remoteLabel: label },
        reasonSkipped, createdAt: now, lastSeenAt: now,
      });
      if (!isRemote) { skippedNonRemote++; continue; }
      // Lapis anti-duplikat: fuzzy title+company 30 hari
      const dup = s.company ? await findJobListingFuzzy(s.title, s.company) : undefined;
      if (dup) continue; // sudah ada 30 hari terakhir -> skip insert listing ganda
      const score = scoreJob({ title: s.title, description: s.description, postedDate: s.postedDate });
      await upsertJobListing({
        id: uid("jl_"), source: target.source, externalId: extId,
        title: s.title || target.keyword, company: s.company || "Unknown",
        location, url: normUrl, salaryText: s.salaryText,
        remoteLabel: label, reviewFlag, score, status: "New",
        hidden: false, postedDate: s.postedDate, firstSeenAt: now, lastSeenAt: now, createdAt: now,
      });
      listings++;
    }
    await updateJobTarget(target.id, { status: "DONE" });
    return { keyword: target.keyword, source: target.source, rawCount: scraped.length, listingCount: listings, skippedNonRemote };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const captcha = /captcha|block|verify you are human/i.test(msg);
    await updateJobTarget(target.id, { status: "FAILED", lastError: msg.slice(0, 500) });
    return { keyword: target.keyword, source: target.source, captcha };
  }
}

export async function ensureJobBuffer(): Promise<void> {
  // Refill jika New < 20 (volume kecil OK, asal up-to-date). Dipanggil cron 15 mnt.
  const list = await getJobListings({ status: "New", limit: 25 });
  if (list.length < 20) {
    await processNextJobTarget();
  }
}
