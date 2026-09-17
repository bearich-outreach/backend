import crypto from "crypto";
import {
  claimNextJobTarget, claimRecycledJobTarget, peekNextJobTarget, updateJobTarget, upsertJobRaw, upsertJobListing,
  findJobListingFuzzy, getJobListings, normalizeJobUrl, recordSkillSightings,
} from "../db";
import { scrapeJobs } from "../services/jobScrape";
import { scoreJob, detectRemoteLabel } from "../services/jobScoring";
import { extractSkillsWithGroups } from "../services/jobSkills";
import type { JobSource } from "../types";
import { uid, todayISO } from "../store";

function hash(s: string) { return crypto.createHash("md5").update(s).digest("hex").slice(0, 16); }

// Pacing per source (in-memory): JobStreet + Indeed yang memblokir bot hanya boleh
// dicoba ~1x/jam tiap source, Glints tetap tiap tick 15 mnt. Berlaku untuk cron
// maupun tombol manual karena keduanya lewat processNextJobTarget. Restart proses
// me-reset timer (efek terburuk: 1 hit ekstra setelah deploy — dapat diterima).
const lastStrictRunAt: Record<string, number> = { jobstreet: 0, indeed: 0 };
function strictMinIntervalMs(source: JobSource): number {
  const key = source === "jobstreet" ? "JOBS_JOBSTREET_MIN_INTERVAL_MS" : "JOBS_INDEED_MIN_INTERVAL_MS";
  const v = Number(process.env[key] ?? 3600000);
  return Number.isFinite(v) && v >= 0 ? v : 3600000;
}
function isStrictThrottled(source: JobSource): boolean {
  if (source !== "jobstreet" && source !== "indeed") return false;
  return Date.now() - (lastStrictRunAt[source] ?? 0) < strictMinIntervalMs(source);
}

export async function processNextJobTarget(): Promise<{ keyword?: string; source?: string; rawCount?: number; listingCount?: number; skippedNonRemote?: number; throttled?: boolean; captcha?: boolean; recycled?: boolean; noEligible?: boolean }> {
  // Kolam 68 terus berputar: PENDING dulu, bila kosong putar ulang DONE
  // paling lama yang sudah >= cooldown (default 24 jam). FAILED tidak ikut —
  // tetap manual via Retry agar tidak menghajar situs pemblokir.
  // Target openwebninja dikecualikan di sini (dikerjakan worker API harian).
  const next = await peekNextJobTarget(["openwebninja"]);
  if (!next) return { noEligible: true };
  let sourceFilter: JobSource | undefined;
  if ((next.source === "jobstreet" || next.source === "indeed") && isStrictThrottled(next.source)) sourceFilter = "glints";
  let target = await claimNextJobTarget(sourceFilter, ["openwebninja"]);
  let recycled = false;
  if (!target) {
    // Tidak ada PENDING yang eligible (habis / kena backoff) -> coba recycle DONE lama.
    target = await claimRecycledJobTarget(sourceFilter, ["openwebninja"]);
    recycled = Boolean(target);
  }
  if (!target) return { throttled: Boolean(sourceFilter), source: sourceFilter ?? next.source, noEligible: true };
  if (target.source === "jobstreet" || target.source === "indeed") lastStrictRunAt[target.source] = Date.now();
  try {
    const scraped = await scrapeJobs(target.keyword, target.source);
    if (scraped.length === 0 && process.env.USE_PLAYWRIGHT === "true") {
      await updateJobTarget(target.id, { status: "FAILED", lastError: "tidak ada hasil (kemungkinan throttling/block, bisa retry)" });
      return { keyword: target.keyword, source: target.source, rawCount: 0, listingCount: 0 };
    }
    const now = todayISO();
    let listings = 0, skippedNonRemote = 0;
    for (const s of scraped) {
      const normUrl = normalizeJobUrl(s.url, target.source);
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
        title: s.title, company: s.company, location, url: normUrl, clickUrl: s.url,
        postedDate: s.postedDate,
        payload: { keyword: target.keyword, salaryText: s.salaryText, description: (s.description ?? "").slice(0, 2000), workArrangement: arrangement, verifiedDetail: s.verifiedDetail ?? false, remoteLabel: label },
        reasonSkipped, createdAt: now, lastSeenAt: now,
      });
      if (!isRemote) { skippedNonRemote++; continue; }
      // Lapis anti-duplikat: fuzzy title+company 30 hari
      const dup = s.company ? await findJobListingFuzzy(s.title, s.company) : undefined;
      if (dup) continue; // sudah ada 30 hari terakhir -> skip insert listing ganda
      const score = scoreJob({ title: s.title, description: s.description, postedDate: s.postedDate });
      const listingId = uid("jl_");
      await upsertJobListing({
        id: listingId, source: target.source, externalId: extId,
        title: s.title || target.keyword, company: s.company || "Unknown",
        location, url: normUrl, clickUrl: s.url, salaryText: s.salaryText,
        descriptionSnippet: (s.description ?? "").slice(0, 2000) || undefined,
        remoteLabel: label, reviewFlag, score, status: "New",
        hidden: false, postedDate: s.postedDate, firstSeenAt: now, lastSeenAt: now, createdAt: now,
      });
      // Riwayat skill permanen: tetap tercatat walau lowongan kelak dihapus.
      try {
        const found = extractSkillsWithGroups(s.title || target.keyword, s.description);
        if (found.length) {
          await recordSkillSightings({ listingId, source: target.source, externalId: extId, skills: found, seenAt: now });
        }
      } catch { /* riwayat gagal tidak boleh menggagalkan scrape */ }
      listings++;
    }
    await updateJobTarget(target.id, { status: "DONE" });
    return { keyword: target.keyword, source: target.source, rawCount: scraped.length, listingCount: listings, skippedNonRemote, recycled };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const captcha = /captcha|block|verify you are human/i.test(msg);
    await updateJobTarget(target.id, { status: "FAILED", lastError: msg.slice(0, 500) });
    return { keyword: target.keyword, source: target.source, captcha, recycled };
  }
}

export async function ensureJobBuffer(): Promise<void> {
  // Refill jika New < 20 (volume kecil OK, asal up-to-date). Dipanggil cron 15 mnt.
  const list = await getJobListings({ status: "New", limit: 25 });
  if (list.length < 20) {
    await processNextJobTarget();
  }
}
