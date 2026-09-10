import crypto from "crypto";
import {
  claimNextJobTarget, updateJobTarget, upsertJobRaw, upsertJobListing,
  findJobListingFuzzy, getJobListings, normalizeJobUrl,
} from "../db";
import { scrapeJobs } from "../services/jobScrape";
import { scoreJob, detectRemoteLabel } from "../services/jobScoring";
import { uid, todayISO } from "../store";

function hash(s: string) { return crypto.createHash("md5").update(s).digest("hex").slice(0, 16); }

export async function processNextJobTarget(): Promise<{ keyword?: string; source?: string; rawCount?: number; listingCount?: number; captcha?: boolean }> {
  const target = await claimNextJobTarget();
  if (!target) return {};
  try {
    const scraped = await scrapeJobs(target.keyword, target.source);
    if (scraped.length === 0 && process.env.USE_PLAYWRIGHT === "true") {
      await updateJobTarget(target.id, { status: "FAILED", lastError: "tidak ada hasil (kemungkinan throttling/block, bisa retry)" });
      return { keyword: target.keyword, source: target.source, rawCount: 0, listingCount: 0 };
    }
    const now = todayISO();
    let listings = 0;
    for (const s of scraped) {
      const normUrl = normalizeJobUrl(s.url);
      const extId = s.externalId || `job-${hash(normUrl)}`;
      // Lapis 1 anti-duplikat: fuzzy title+company 30 hari
      const dup = s.company ? await findJobListingFuzzy(s.title, s.company) : undefined;
      const reasonSkipped = "";
      await upsertJobRaw({
        id: uid("jr_"), source: target.source, externalId: extId,
        title: s.title, company: s.company, location: s.location, url: normUrl,
        postedDate: s.postedDate, payload: { keyword: target.keyword, salaryText: s.salaryText },
        reasonSkipped, createdAt: now, lastSeenAt: now,
      });
      if (dup) continue; // sudah ada 30 hari terakhir -> skip insert listing ganda
      // Semua tetap masuk (lock final), label Remote / Perlu Cek dari detail
      const { label, reviewFlag } = detectRemoteLabel(s.location, `${s.description ?? ""} ${s.title}`);
      const score = scoreJob({ title: s.title, description: s.description, postedDate: s.postedDate });
      await upsertJobListing({
        id: uid("jl_"), source: target.source, externalId: extId,
        title: s.title || target.keyword, company: s.company || "Unknown",
        location: s.location || "Remote", url: normUrl, salaryText: s.salaryText,
        remoteLabel: label, reviewFlag, score, status: "New",
        hidden: false, postedDate: s.postedDate, firstSeenAt: now, lastSeenAt: now, createdAt: now,
      });
      listings++;
    }
    await updateJobTarget(target.id, { status: "DONE" });
    return { keyword: target.keyword, source: target.source, rawCount: scraped.length, listingCount: listings };
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
