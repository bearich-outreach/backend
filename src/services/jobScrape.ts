// Scraper Glints + JobStreet (tanpa login, publik saja).
// Pola sama seperti outreach mapsScrape: Playwright bila USE_PLAYWRIGHT=true,
// else mock agar dev lokal tidak block. Throttle 2-5s, max 15/keyword.

export type WorkArrangement = "REMOTE" | "HYBRID" | "ONSITE" | "UNKNOWN";

export interface ScrapedJob {
  externalId: string;
  title: string;
  company: string;
  location: string;
  url: string;
  salaryText?: string;
  description?: string;
  postedDate?: string;
  /** Hasil klasifikasi arrangement dari kartu/detail (label Glints ID+EN). */
  workArrangement?: WorkArrangement;
  /** True bila arrangement sudah dikonfirmasi lewat halaman detail. */
  verifiedDetail?: boolean;
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

// Opsi A: pakai system chromium dari Dockerfile (apk chromium) bila ada,
// agar tidak tergantung cache Playwright (/root/.cache/ms-playwright/...).
// Fallback ke default Playwright bila file tidak ditemukan (dev lokal).
async function resolveChromiumExe(): Promise<string | undefined> {
  const { existsSync } = await import("fs");
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ].filter(Boolean) as string[];
  for (const p of candidates) {
    try { if (existsSync(p)) return p; } catch {}
  }
  return undefined;
}

function mockJobs(keyword: string, source: "glints" | "jobstreet"): ScrapedJob[] {
  const now = new Date();
  return [0, 1].map((i) => ({
    externalId: `mock-${source}-${keyword.replace(/\W+/g, "-").toLowerCase()}-${i}`,
    title: keyword,
    company: `PT Contoh Web ${i + 1}`,
    location: "Remote",
    url: source === "glints"
      ? `https://glints.com/id/opportunities/jobs/mock-${i}`
      : `https://id.jobstreet.com/job/mock-${i}`,
    salaryText: "",
    description: `${keyword} remote, WFH. Cocok untuk junior/intern.`,
    postedDate: new Date(now.getTime() - i * 2 * 86400000).toISOString(),
    workArrangement: "REMOTE",
    verifiedDetail: false,
  }));
}

/**
 * Klasifikasi badge arrangement Glints dari teks kartu.
 * Label Glints (ID): "Kerja di lokasi" (onsite), "Kerja di lokasi / rumah" (hybrid),
 * "Remote/dari rumah" / "Remote/WFH" (remote). Urutan cek penting: hybrid dulu
 * (mengandung frasa "kerja di lokasi"), baru remote, baru onsite.
 */
export function parseCardArrangement(cardText: string): WorkArrangement {
  const t = cardText.toLowerCase();
  if (/kerja di lokasi\s*\/\s*rumah|hybrid/i.test(cardText)) return "HYBRID";
  if (/remote\/dari rumah|remote\/wfh|\bremote\b|\bwfh\b|work from home|fully remote|kerja remote|dari rumah/i.test(cardText)) return "REMOTE";
  if (/kerja di lokasi|onsite|on-site|\bwfo\b|hadir ke kantor|penempatan/i.test(cardText)) return "ONSITE";
  void t;
  return "UNKNOWN";
}

const KNOWN_CITIES = [
  "jakarta", "bogor", "depok", "tangerang", "bekasi", "bandung", "semarang",
  "yogyakarta", "jogja", "surabaya", "malang", "denpasar", "bali", "medan",
  "makassar", "balikpapan", "singapura", "singapore", "kuala lumpur",
];

/** Ekstrak lokasi asli dari teks kartu (kota + wilayah). "" bila tak ditemukan. */
export function extractCardLocation(cardText: string, titleGuess: string): string {
  const lines = cardText.split("\n").map((s) => s.trim()).filter(Boolean);
  for (const line of lines.slice(0, 8)) {
    if (line === titleGuess) continue;
    const low = line.toLowerCase();
    if (line.length > 90) continue;
    if (/rp\s?[\d.,]|idr|jt\b|rb\b|full-time|full time|part-time|magang|kontrak|freelance|internship|remote\/|kerja di lokasi|apply|lamar|save|hari|tahun|minimal|sma|smk|diploma|sarjana/i.test(line)) continue;
    if (/,/.test(line) || KNOWN_CITIES.some((c) => low.includes(c))) return line.slice(0, 90);
  }
  return "";
}

async function scrapeViaPlaywright(keyword: string, source: "glints" | "jobstreet"): Promise<ScrapedJob[]> {
  const { chromium } = await import("playwright");
  const exe = await resolveChromiumExe();
  const browser = await chromium.launch({
    headless: true,
    ...(exe ? { executablePath: exe } : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
  });
  try {
    const page = await browser.newPage({
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      locale: "id-ID",
      viewport: { width: 1366, height: 900 },
    });
    // URL Glints valid (diverifikasi 200 OK): /id/opportunities/jobs/explore?keyword=..&country=ID&...
    // Percobaan filter remote server-side: Glints memakai ?filter=remote di halaman
    // explore lain (/site/explore). Parameter asing umumnya diabaikan server sehingga
    // aman dicoba — bila 0 hasil, fallback ke URL terbukti di bawah (tanpa request ekstra
    // bila percobaan pertama sudah berisi hasil).
    const kwPlus = encodeURIComponent(keyword).replace(/%20/g, "+");
    const glintsBase = `https://glints.com/id/opportunities/jobs/explore?keyword=${kwPlus}&country=ID&locationName=All+Cities%2FProvinces&lowestLocationLevel=1`;
    const glintsFiltered = `${glintsBase}&filter=remote`;
    const jobstreetUrl = `https://id.jobstreet.com/id/${encodeURIComponent(keyword.replace(/\s+/g, "-").toLowerCase())}-jobs?where=Remote&sortmode=ListedDate`;
    const urlCandidates = source === "glints" ? [glintsFiltered, glintsBase] : [jobstreetUrl];
    let urlUsed = urlCandidates[0];
    let html = "";
    let links: { href: string; text: string; aria: string; card: string }[] = [];
    // Tunggu render SPA: selector khusus per sumber (bukan 1 selector generik).
    const selector = source === "glints"
      ? "a[href*='/opportunities/jobs/']"
      : "a[href*='/job/']";
    for (const candidate of urlCandidates) {
      urlUsed = candidate;
      await page.goto(candidate, { waitUntil: "domcontentloaded", timeout: 60000 });
      try {
        await page.waitForSelector(selector, { timeout: 20000 });
      } catch {
        // belum muncul — lanjut ke scroll, debug ditentukan di bawah bila tetap 0
      }
      // Scroll 4x untuk trigger lazy-load (tiru collectResultHrefs mapsScrape).
      for (let i = 0; i < 4; i++) {
        try { await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight)); } catch {}
        await sleep(1200 + Math.random() * 1200);
      }
      html = await page.content();
      // Deteksi block dari TEKS TERLIHAT + judul (bukan HTML mentah): bundle JS
      // halaman normal (mis. reCAPTCHA) mengandung kata "captcha" sehingga cek
      // HTML mentah rawan false positive. Halaman block sungguhan selalu
      // menampilkan teks ke manusia, jadi presisi tidak berkurang.
      const visibleText = await page.evaluate(() => document.body.innerText.slice(0, 6000)).catch(() => "");
      const titleNow = await page.title().catch(() => "");
      const visLower = `${visibleText}\n${titleNow}`.toLowerCase();
      const blockSignal = /captcha|unusual traffic|verify you are human|cf-challenge|access denied|attention required/i.exec(visLower);
      if (blockSignal) {
        console.log(`[jobs] ${source} "${keyword}" BLOCK sinyal="${blockSignal[0].toLowerCase()}" title="${titleNow.slice(0, 80)}" html=${Math.round(html.length / 1024)}kb url="${page.url().slice(0, 120)}"`);
        throw new Error("captcha: block terdeteksi di " + source);
      }
      if (visLower.includes("log in to apply") && !html.toLowerCase().includes("opportunities/jobs")) {
        console.log(`[jobs] ${source} "${keyword}" LOGIN_WALL title="${titleNow.slice(0, 80)}" html=${Math.round(html.length / 1024)}kb`);
        throw new Error("login_required: glints meminta login di halaman explore");
      }
      // Ekstrak anchor + konteks kartu (company ada di teks kartu, bukan anchor saja).
      links = await page.$$eval(selector, (els) =>
        els.slice(0, 20).map((a) => {
          const el = a as HTMLAnchorElement;
          const card = (el.closest("div") as HTMLElement | null)?.innerText?.slice(0, 600) ?? "";
          return {
            href: el.href,
            text: (el.textContent || "").trim().slice(0, 200),
            aria: (el.getAttribute("aria-label") || "").slice(0, 200),
            card,
          };
        })
      );
      // URL berfilter kosong tapi URL terbukti belum dicoba -> coba fallback 1x.
      if (links.length > 0 || candidate === urlCandidates[urlCandidates.length - 1]) break;
      console.log(`[jobs] ${source} "${keyword}" filter kosong, fallback ke URL tanpa filter`);
    }
    if (links.length === 0) {
      const title = await page.title().catch(() => "");
      const anchorCount = await page.locator("a").count().catch(() => -1);
      throw new Error(
        `EMPTY_RENDER ${source} title="${title.slice(0, 80)}" url="${page.url().slice(0, 120)}" html=${Math.round(html.length / 1024)}kb anchors=${anchorCount} jobLinks=0`
      );
    }
    const seen = new Set<string>();
    const out: ScrapedJob[] = [];
    let cardRemote = 0, cardHybrid = 0, cardOnsite = 0, cardUnknown = 0;
    for (const l of links) {
      if (!l.href || seen.has(l.href)) continue;
      // Hanya URL detail (ada UUID / id numerik), bukan halaman explore/filter.
      const uuid = l.href.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1]
        ?? l.href.match(/([0-9]{6,})/)?.[1];
      if (!uuid) continue;
      seen.add(l.href);
      // Company dari baris kartu (baris ke-2 yang bukan judul, max 80 char).
      let company = "";
      const lines = l.card.split("\n").map((s) => s.trim()).filter(Boolean);
      const titleGuess = l.text || l.aria || keyword;
      for (const line of lines.slice(0, 5)) {
        if (line !== titleGuess && line.length <= 80 && !/apply|lamar|save|hari/i.test(line)) { company = line; break; }
      }
      // Arrangement + lokasi ASLI dari kartu (jangan hardcode "Remote").
      const arrangement = source === "glints" ? parseCardArrangement(l.card) : "REMOTE";
      const location = source === "glints"
        ? (extractCardLocation(l.card, titleGuess) || (arrangement === "REMOTE" ? "Remote" : ""))
        : "Remote"; // JobStreet sudah difilter ?where=Remote di URL
      if (arrangement === "REMOTE") cardRemote++;
      else if (arrangement === "HYBRID") cardHybrid++;
      else if (arrangement === "ONSITE") cardOnsite++;
      else cardUnknown++;
      out.push({
        externalId: `${source}-${uuid}`,
        title: titleGuess,
        company,
        location,
        url: l.href,
        description: "",
        workArrangement: arrangement,
        verifiedDetail: false,
      });
      if (out.length >= 15) break;
    }
    // Verifikasi detail: hanya kandidat REMOTE/UNKNOWN, max 5/run, sequential,
    // jeda 3-6 dtk (hemat risiko block). ONSITE/HYBRID jelas langsung dibuang
    // di worker tanpa kunjungan detail. UNKNOWN ikut dibuka (regex kartu rapuh).
    // Berhenti total bila kena captcha/login di tengah jalan.
    let detailChecked = 0, detailConfirmed = 0;
    const maxDetail = Math.min(5, out.length);
    for (const job of out) {
      if (detailChecked >= maxDetail) break;
      if (job.workArrangement !== "REMOTE" && job.workArrangement !== "UNKNOWN") continue;
      detailChecked++;
      try {
        await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 45000 });
        await sleep(1500);
        const detailText = await page.evaluate(() => document.body.innerText.slice(0, 4000)).catch(() => "");
        const dl = detailText.toLowerCase();
        const detailSignal = /captcha|unusual traffic|verify you are human|cf-challenge|access denied|attention required/i.exec(dl);
        if (detailSignal) {
          const detailTitle = await page.title().catch(() => "");
          console.log(`[jobs] ${source} "${keyword}" stop detail: sinyal="${detailSignal[0].toLowerCase()}" title="${detailTitle.slice(0, 80)}" di ${job.url.slice(0, 80)}`);
          break;
        }
        const detailArr = parseCardArrangement(detailText);
        if (detailArr !== "UNKNOWN") job.workArrangement = detailArr;
        // Lokasi detail lebih akurat — timpa bila kartu kosong/tak jelas.
        const detailLoc = extractCardLocation(detailText, job.title);
        if (detailLoc) job.location = detailLoc;
        else if (!job.location && job.workArrangement === "REMOTE") job.location = "Remote";
        const descLines = detailText.split("\n").map((s) => s.trim()).filter((s) => s.length > 40).slice(0, 3);
        if (descLines.length) job.description = descLines.join(" ").slice(0, 800);
        job.verifiedDetail = true;
        if (job.workArrangement === "REMOTE") detailConfirmed++;
      } catch {
        // Gagal 1 detail (timeout/RST) -> pertahankan data kartu, lanjut kandidat berikut.
      }
      await sleep(3000 + Math.random() * 3000);
    }
    // Log 1 baris per run agar cukup docker logs | grep jobs.
    console.log(`[jobs] ${source} "${keyword}" links=${out.length} card(remote=${cardRemote} hybrid=${cardHybrid} onsite=${cardOnsite} unknown=${cardUnknown}) detail(checked=${detailChecked} confirmed=${detailConfirmed}) html=${Math.round(html.length / 1024)}kb filtered=${urlUsed.includes("filter=remote")}`);
    return out;
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function scrapeJobs(keyword: string, source: "glints" | "jobstreet"): Promise<ScrapedJob[]> {
  const usePlaywright = process.env.USE_PLAYWRIGHT === "true";
  if (usePlaywright) {
    try {
      const res = await scrapeViaPlaywright(keyword, source);
      if (res.length > 0) return res;
      if (process.env.NODE_ENV === "production") return [];
    } catch (e) {
      throw e;
    }
  }
  if (process.env.MOCK_SCRAPE === "true" || process.env.NODE_ENV !== "production" || !usePlaywright) {
    return mockJobs(keyword, source);
  }
  return [];
}
