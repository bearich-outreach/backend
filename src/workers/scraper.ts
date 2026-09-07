import crypto from "crypto";
import { upsertRawLead, claimNextSearchTarget, updateSearchTarget, getQualifiedLeads } from "../db";
import { normalizePhone, isClosedStatus } from "../services/cleansing";
import { scoreLead } from "../services/scoring";
import { verifyWA } from "../services/waVerify";
import { RawLead } from "../types";
import { uid, todayISO } from "../store";
import { getSettings } from "../db";
import { insertQualifiedLead } from "../db";
import { generateQualifiedMessage } from "../services/messageGenerator";

function md5(s: string) { return crypto.createHash("md5").update(s).digest("hex"); }

// Simplified scraper: in production uses Playwright to scrape Maps.
// For now generates 1-3 mock raw leads per keyword to demonstrate pipeline.
// Real playwright block is guarded by PLAYWRIGHT env.
async function scrapeKeyword(keyword: string, city: string, category: string): Promise<RawLead[]> {
  const tryPlaywright = process.env.USE_PLAYWRIGHT === "true";
  if (tryPlaywright) {
    try {
      const { chromium } = await import("playwright");
      const uaList = [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/119.0.0.0 Mobile Safari/537.36",
      ];
      const browser = await chromium.launch({
        headless: true,
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
        args: ["--no-sandbox"],
      });
      const ctx = await browser.newContext({ userAgent: uaList[Math.floor(Math.random()*uaList.length)] });
      const page = await ctx.newPage();
      await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(keyword)}`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(2000 + Math.random()*3000);
      // placeholder: real extraction would parse place_id, rating, etc.
      await browser.close();
    } catch {
      // fallthrough to mock
    }
  }
  // mock 2 leads per keyword
  const leads: RawLead[] = [];
  const now = todayISO();
  for (let i=0; i<2; i++) {
    const name = `${category} ${city} ${i+1}`;
    const address = `${city} Jl. Contoh ${i+1}`;
    const placeId = "ChIJ" + md5(name+address).slice(0,22);
    leads.push({
      id: uid("raw_"),
      placeId,
      name,
      address,
      phoneRaw: `0812${Math.floor(10000000+Math.random()*90000000)}`,
      website: Math.random() > 0.6 ? "" : `https://${name.replace(/\s+/g,"").toLowerCase()}.com`,
      rating: Number((3.5+Math.random()*1.5).toFixed(1)),
      reviewCount: Math.floor(Math.random()*120),
      mapsStatus: "OPERATIONAL",
      city, category, keyword,
      rawJson: { keyword, mock: true },
      createdAt: now,
      lastSeenAt: now,
    });
  }
  return leads;
}

export async function processNextTarget(): Promise<{ keyword?: string; rawCount?: number; qualifiedCount?: number; captcha?: boolean }> {
  const target = await claimNextSearchTarget();
  if (!target) return {};
  try {
    const rawLeads = await scrapeKeyword(target.keyword, target.city, target.category);
    if (rawLeads.some(r => isClosedStatus(r.mapsStatus))) {
      // filter closed
    }
    let qualified = 0;
    const settings = await getSettings();
    for (const raw of rawLeads) {
      if (isClosedStatus(raw.mapsStatus)) continue;
      const phone628 = normalizePhone(raw.phoneRaw);
      if (!phone628) continue;
      // throttle verify: only for potential high score without WA
      const preliminary = scoreLead(raw, false);
      // need >55 to even verify WA
      if (preliminary < 35) continue; // low value skip to save verify calls
      const waVerified = await verifyWA(phone628);
      const total = scoreLead(raw, waVerified);
      await upsertRawLead(raw);
      if (total >= 70) {
        const { message, variants } = await generateQualifiedMessage(raw, settings);
        await insertQualifiedLead({
          id: uid("ql_"),
          placeId: raw.placeId,
          name: raw.name,
          company: raw.name,
          phone628,
          city: raw.city,
          category: raw.category,
          rating: raw.rating,
          reviewCount: raw.reviewCount,
          website: raw.website,
          score: total,
          waVerified,
          message,
          messageVariants: variants,
          status: "New Lead",
          createdAt: todayISO(),
        });
        qualified++;
      }
    }
    // prune junk >180d (run opportunistically)
    // update target DONE
    await updateSearchTarget(target.id, { status: "DONE" });

    // auto-refill check: if New Lead <10, next target will be claimed on next cron, not here to avoid loop

    return { keyword: target.keyword, rawCount: rawLeads.length, qualifiedCount: qualified };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const captcha = /captcha/i.test(msg);
    await updateSearchTarget(target.id, { status: "FAILED", lastError: msg.slice(0, 500) });
    return { keyword: target.keyword, captcha };
  }
}

export async function ensureBuffer(): Promise<void> {
  const leads = await getQualifiedLeads({ status: "New Lead", limit: 20 });
  if (leads.length < 10) {
    // trigger one more target (caller will loop cron)
    await processNextTarget();
  }
}
