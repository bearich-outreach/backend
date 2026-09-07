import crypto from "crypto";
import { upsertRawLead, claimNextSearchTarget, updateSearchTarget, getQualifiedLeads, upsertWaPending, getDueWaPending, deleteWaPending } from "../db";
import { normalizePhone, isClosedStatus } from "../services/cleansing";
import { scoreLead } from "../services/scoring";
import { verifyWA } from "../services/waVerify";
import { scrapeMapsPlaces } from "../services/mapsScrape";
import { RawLead } from "../types";
import { uid, todayISO } from "../store";
import { getSettings } from "../db";
import { insertQualifiedLead } from "../db";
import { generateQualifiedMessage } from "../services/messageGenerator";

function md5(s: string) { return crypto.createHash("md5").update(s).digest("hex"); }

// URL Maps untuk alamat tempat:
// 1. URL kanonis asli dari hasil scrape -> membuka pin/listing yang tepat.
// 2. place_id ChIJ asli -> query_place_id.
// 3. Fallback query teks (tidak membuka pin spesifik).
export function mapsUrlFor(placeId: string | undefined, name: string, address?: string, city?: string, canonicalUrl?: string): string {
  if (canonicalUrl && canonicalUrl.includes("/maps/")) return canonicalUrl;
  if (placeId && /^ChIJ[A-Za-z0-9_-]+$/.test(placeId)) return `https://www.google.com/maps/search/?api=1&query_place_id=${encodeURIComponent(placeId)}`;
  const q = [name, address, city].filter(Boolean).join(", ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

// Scrape asli Google Maps via Playwright.
// - USE_PLAYWRIGHT=true -> hasil asli (wajib di production).
// - Mock hanya untuk dev lokal (MOCK_SCRAPE=true) agar tidak ada data palsu di prod.
async function scrapeKeyword(keyword: string, city: string, category: string): Promise<RawLead[]> {
  const usePlaywright = process.env.USE_PLAYWRIGHT === "true";
  if (usePlaywright) {
    const places = await scrapeMapsPlaces(keyword);
    if (places.length > 0) {
      const now = todayISO();
      return places.map((p) => ({
        id: uid("raw_"),
        placeId: p.placeKey,
        name: p.name, // nama asli tempat
        address: p.address, // alamat asli
        phoneRaw: p.phoneRaw,
        website: p.website,
        rating: p.rating,
        reviewCount: p.reviewCount,
        mapsStatus: "OPERATIONAL" as const,
        city, category, keyword,
        rawJson: { keyword, source: "maps", canonicalUrl: p.detailUrl },
        createdAt: now,
        lastSeenAt: now,
      }));
    }
    // tidak ada hasil asli -> kembalikan kosong (jangan karang data)
    if (process.env.NODE_ENV === "production") return [];
  }
  if (process.env.MOCK_SCRAPE === "true" || process.env.NODE_ENV !== "production") {
    return mockLeads(keyword, city, category);
  }
  return [];
}

function mockLeads(keyword: string, city: string, category: string): RawLead[] {
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

export async function processNextTarget(): Promise<{ keyword?: string; rawCount?: number; qualifiedCount?: number; captcha?: boolean; retried?: number }> {
  // 1) Retry antrian tunda verifikasi WA dulu (gateway error sebelumnya)
  let retried = 0;
  try {
    const due = await getDueWaPending(20);
    for (const p of due) {
      const waStatus = await verifyWA(p.phone_628);
      if (waStatus === null) {
        await upsertWaPending({ placeId: p.place_id, phone628: p.phone_628, name: p.name, city: p.city, category: p.category });
        continue;
      }
      if (waStatus === false) { await deleteWaPending(p.place_id); continue; } // WA tidak aktif -> buang dari antrian, tidak jadi qualified
      await deleteWaPending(p.place_id);
      retried++;
      // detail raw lengkap akan masuk lewat scrape berikutnya; pending hanya menandai nomor sudah aktif
    }
  } catch { /* retry best-effort, lanjut ke scrape */ }
  const target = await claimNextSearchTarget();
  if (!target) return {};
  try {
    const rawLeads = await scrapeKeyword(target.keyword, target.city, target.category);
    if (rawLeads.length === 0 && process.env.USE_PLAYWRIGHT === "true") {
      // Kemungkinan throttling Google / tidak ada hasil: JANGAN tandai DONE agar tidak hangus.
      await updateSearchTarget(target.id, { status: "FAILED", lastError: "tidak ada hasil (kemungkinan throttling Google, bisa di-retry)" });
      return { keyword: target.keyword, rawCount: 0, qualifiedCount: 0, retried };
    }
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
      const waStatus = await verifyWA(phone628);
      await upsertRawLead(raw);
      if (waStatus === null) {
        // Gateway error/timeout: tunda, masuk antrian retry — BUKAN qualified
        await upsertWaPending({ placeId: raw.placeId, phone628, name: raw.name, city: raw.city, category: raw.category });
        continue;
      }
      if (waStatus === false) continue; // WA tidak aktif / tidak lolos verifikasi -> bukan qualified
      const total = scoreLead(raw, true);
      if (total >= 70) {
        const { message, variants } = await generateQualifiedMessage(raw, settings);
        await insertQualifiedLead({
          id: uid("ql_"),
          placeId: raw.placeId,
          name: raw.name,
          company: raw.name,
          address: raw.address,
          mapsUrl: mapsUrlFor(raw.placeId, raw.name, raw.address, raw.city, (raw.rawJson as { canonicalUrl?: string } | undefined)?.canonicalUrl),
          phone628,
          city: raw.city,
          category: raw.category,
          rating: raw.rating,
          reviewCount: raw.reviewCount,
          website: raw.website,
          score: total,
          waVerified: true,
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

    return { keyword: target.keyword, rawCount: rawLeads.length, qualifiedCount: qualified, retried };
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
