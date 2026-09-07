import crypto from "crypto";
import type { Browser, Page } from "playwright";

// Hasil scrape asli dari Google Maps (bukan mock).
export interface ScrapedPlace {
  name: string;
  address: string;
  phoneRaw: string;
  website: string;
  rating?: number;
  reviewCount: number;
  detailUrl: string; // URL kanonis listing -> dipakai sebagai link Maps (membuka pin aslinya)
  placeKey: string; // kunci dedup stabil: ChIJ asli bila ada, else hash URL kanonis
}

interface ScrapeOpts {
  maxResults?: number;
}

const UA_LIST = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/119.0.0.0 Mobile Safari/537.36",
];

function md5(s: string) {
  return crypto.createHash("md5").update(s).digest("hex");
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Satu instance browser dipakai ulang antar keyword (hemat waktu + RAM).
// Pakai Chromium penuh mode --headless=new (Google Maps terlalu berat untuk headless-shell lama).
let browserPromise: Promise<Browser> | undefined;
async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = (async () => {
      const { chromium } = await import("playwright");
      const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
      const baseArgs = ["--no-sandbox", "--disable-blink-features=AutomationControlled"];
      try {
        return await chromium.launch({ headless: false, executablePath: exe, args: ["--headless=new", ...baseArgs] });
      } catch {
        return await chromium.launch({ headless: true, executablePath: exe, args: baseArgs });
      }
    })();
  }
  return browserPromise;
}

// "214 ulasan" / "(1.234)" / "(1,2 rb)" / "2.5K reviews" -> angka.
// Prioritaskan angka yang diikuti kata ulasan/review agar tidak salah ambil rating.
export function parseReviewCount(s: string): number {
  const str = String(s);
  const m =
    str.match(/([\d.,]+)\s*(rb|jt|[kKmM])\b\s*(ulasan|reviews?)?/i) ||
    str.match(/([\d.,]+)\s*(ulasan|reviews?)/i) ||
    str.match(/\(\s*([\d.,]+)\s*([a-zA-Z]*)\s*\)/) ||
    str.match(/([\d.,]+)\s*([a-zA-Z]*)/);
  if (!m) return 0;
  const num = Number(m[1].replace(/\./g, "").replace(",", "."));
  if (!Number.isFinite(num)) return 0;
  const suf = (m[2] || "").toLowerCase();
  if (suf.startsWith("k") || suf.startsWith("rb")) return Math.round(num * 1000);
  if (suf.startsWith("m") || suf.startsWith("jt")) return Math.round(num * 1000000);
  return Math.round(num);
}

async function dismissConsent(page: Page): Promise<void> {
  try {
    const btn = page.locator('button:has-text("Tolak semua"), button:has-text("Reject all")').first();
    if (await btn.count()) {
      await btn.click({ timeout: 4000 }).catch(() => {});
      await sleep(800);
    }
  } catch { /* abaikan */ }
}

// Halaman sorry/captcha Google -> lempar error mengandung "captcha"
// agar processNextTarget menandai target FAILED + flag captcha.
async function assertNotSorry(page: Page): Promise<void> {
  const url = page.url();
  if (/google\.\w+\/sorry/i.test(url)) {
    throw new Error("captcha: Google menampilkan halaman sorry (unusual traffic)");
  }
  try {
    const body = await page.locator("body").first().innerText({ timeout: 5000 });
    if (/unusual traffic|ketidakbiasaan lalu lintas|our systems have detected/i.test(body)) {
      throw new Error("captcha: Google mendeteksi traffic tidak biasa");
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("captcha:")) throw e;
  }
}

function stableKeyFromUrl(detailUrl: string): string {
  const m = detailUrl.match(/(ChIJ[A-Za-z0-9_-]+)/);
  if (m) return m[1]; // place_id asli (muncul sebagai ...19sChIJxxx di URL detail)
  const canon = detailUrl.split("#")[0];
  return "URL" + md5(canon).slice(0, 22);
}

async function collectResultHrefs(page: Page, maxResults: number): Promise<{ name: string; href: string }[]> {
  const out = new Map<string, string>();
  const feed = page.locator('div[role="feed"]').first();
  for (let i = 0; i < 8 && out.size < maxResults; i++) {
    const links = await page.locator("a.hfpxzc").all();
    for (const a of links) {
      const href = await a.getAttribute("href").catch(() => null);
      const label = await a.getAttribute("aria-label").catch(() => null);
      if (href && href.includes("/maps/place/") && label && !out.has(href)) {
        out.set(href, label);
        if (out.size >= maxResults) break;
      }
    }
    if (out.size >= maxResults) break;
    // scroll panel hasil untuk memuat kartu berikutnya
    try {
      await feed.evaluate((el) => el.scrollBy(0, el.scrollHeight)).catch(() => {});
    } catch { break; }
    await sleep(1200 + Math.random() * 1200);
  }
  return [...out.entries()].map(([href, name]) => ({ name, href }));
}

async function extractDetail(page: Page, detailUrl: string): Promise<ScrapedPlace | undefined> {
  await page.goto(detailUrl, { waitUntil: "commit", timeout: 60000 });
  await dismissConsent(page);
  await assertNotSorry(page);
  await sleep(1500 + Math.random() * 1500);

  const text = async (sel: string): Promise<string> => {
    try {
      const t = await page.locator(sel).first().textContent({ timeout: 6000 });
      return (t ?? "").trim();
    } catch { return ""; }
  };

  let name = await text("h1");
  if (!name) {
    const title = await page.title().catch(() => "");
    name = title.replace(/\s*-\s*Google Maps\s*$/i, "").trim();
  }
  if (!name) return undefined;

  // Alamat
  let address = "";
  try {
    const addrBtn = page.locator('button[data-item-id="address"]').first();
    if (await addrBtn.count()) {
      const aria = (await addrBtn.getAttribute("aria-label").catch(() => null)) ?? "";
      address = aria.replace(/^(Alamat|Address):\s*/i, "").trim() || (await addrBtn.textContent().catch(() => "") ?? "").trim();
    }
  } catch { /* kosong */ }

  // Telepon
  let phoneRaw = "";
  try {
    const phoneBtn = page.locator('button[data-item-id^="phone:"]').first();
    if (await phoneBtn.count()) {
      const itemId = (await phoneBtn.getAttribute("data-item-id").catch(() => "")) ?? "";
      const tel = itemId.startsWith("phone:tel:") ? itemId.slice("phone:tel:".length) : "";
      phoneRaw = tel || (await phoneBtn.getAttribute("aria-label").catch(() => "") ?? "");
    }
  } catch { /* kosong */ }

  // Website (kadang dibungkus redirect /url?q=)
  let website = "";
  try {
    const w = page.locator('a[data-item-id="authority"]').first();
    if (await w.count()) {
      const href = (await w.getAttribute("href").catch(() => "")) ?? "";
      const m = href.match(/[?&]q=([^&]+)/);
      website = m ? decodeURIComponent(m[1]) : href;
    }
  } catch { /* kosong */ }

  // Rating
  let rating: number | undefined;
  const ratingRaw = (await text("div.F7nice span[aria-hidden='true']")).replace(",", ".");
  const ratingNum = Number(ratingRaw);
  if (Number.isFinite(ratingNum) && ratingNum > 0) rating = ratingNum;

  // Jumlah ulasan: span.UY7F9 "(31)" di samping rating, fallback tombol ulasan
  let reviewCount = 0;
  try {
    const countSpan = page.locator("span.UY7F9").first();
    let countText = "";
    if (await countSpan.count()) {
      countText = (await countSpan.textContent().catch(() => "")) ?? "";
    }
    if (!parseReviewCount(countText)) {
      const revBtn = page.locator('button[aria-label*="ulasan"], button[aria-label*="reviews"], button[aria-label*="review"]').first();
      if (await revBtn.count()) {
        const aria = (await revBtn.getAttribute("aria-label").catch(() => "")) ?? "";
        countText = aria || ((await revBtn.textContent().catch(() => "")) ?? "");
      }
    }
    reviewCount = parseReviewCount(countText);
  } catch { /* 0 */ }

  return {
    name,
    address,
    phoneRaw,
    website,
    rating,
    reviewCount,
    detailUrl: page.url().split("#")[0] || detailUrl,
    placeKey: stableKeyFromUrl(detailUrl),
  };
}

export async function scrapeMapsPlaces(keyword: string, opts: ScrapeOpts = {}): Promise<ScrapedPlace[]> {
  const maxResults = Math.min(Math.max(Number(process.env.RESULTS_PER_KEYWORD || opts.maxResults || 6) || 6, 1), 15);
  const browser = await getBrowser();
  const ctx = await browser.newContext({
    userAgent: UA_LIST[Math.floor(Math.random() * UA_LIST.length)],
    locale: "id-ID",
    viewport: { width: 1366, height: 900 },
  });
  const page = await ctx.newPage();
  try {
    await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(keyword)}`, {
      waitUntil: "commit",
      timeout: 60000,
    });
    await dismissConsent(page);
    await assertNotSorry(page);

    // Kasus redirect langsung ke 1 tempat (keyword sangat spesifik)
    if (/\/maps\/place\//.test(page.url())) {
      const one = await extractDetail(page, page.url());
      return one ? [one] : [];
    }

    try {
      await page.locator('div[role="feed"]').first().waitFor({ timeout: 20000 });
    } catch {
      return []; // tidak ada hasil
    }
    const hrefs = await collectResultHrefs(page, maxResults);
    const places: ScrapedPlace[] = [];
    for (const h of hrefs) {
      try {
        const p = await extractDetail(page, h.href);
        if (p) places.push(p);
      } catch (e) {
        if (e instanceof Error && /^captcha:/.test(e.message)) throw e;
        // 1 tempat gagal -> lanjut ke berikutnya
      }
      await sleep(1000 + Math.random() * 2000);
    }
    return places;
  } finally {
    await page.close().catch(() => {});
    await ctx.close().catch(() => {});
  }
}
