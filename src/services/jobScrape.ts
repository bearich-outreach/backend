// Scraper Glints + JobStreet (tanpa login, publik saja).
// Pola sama seperti outreach mapsScrape: Playwright bila USE_PLAYWRIGHT=true,
// else mock agar dev lokal tidak block. Throttle 2-5s, max 15/keyword.

export interface ScrapedJob {
  externalId: string;
  title: string;
  company: string;
  location: string;
  url: string;
  salaryText?: string;
  description?: string;
  postedDate?: string;
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
  }));
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
    // Filter remote TIDAK dipaksa via query (risiko 404/empty) — remote ditentukan di detail via detectRemoteLabel.
    const kwPlus = encodeURIComponent(keyword).replace(/%20/g, "+");
    const url = source === "glints"
      ? `https://glints.com/id/opportunities/jobs/explore?keyword=${kwPlus}&country=ID&locationName=All+Cities%2FProvinces&lowestLocationLevel=1`
      : `https://id.jobstreet.com/id/${encodeURIComponent(keyword.replace(/\s+/g, "-").toLowerCase())}-jobs?where=Remote&sortmode=ListedDate`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    // Tunggu render SPA: selector khusus per sumber (bukan 1 selector generik).
    const selector = source === "glints"
      ? "a[href*='/opportunities/jobs/']"
      : "a[href*='/job/']";
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
    const html = await page.content();
    const lower = html.toLowerCase();
    if (lower.includes("captcha") || lower.includes("unusual traffic") || lower.includes("verify you are human") || lower.includes("cf-challenge")) {
      throw new Error("captcha: block terdeteksi di " + source);
    }
    if (lower.includes("log in to apply") && !lower.includes("opportunities/jobs")) {
      throw new Error("login_required: glints meminta login di halaman explore");
    }
    // Ekstrak anchor + konteks kartu (company ada di teks kartu, bukan anchor saja).
    const links = await page.$$eval(selector, (els) =>
      els.slice(0, 20).map((a) => {
        const el = a as HTMLAnchorElement;
        const card = (el.closest("div") as HTMLElement | null)?.innerText?.slice(0, 400) ?? "";
        return {
          href: el.href,
          text: (el.textContent || "").trim().slice(0, 200),
          aria: (el.getAttribute("aria-label") || "").slice(0, 200),
          card,
        };
      })
    );
    if (links.length === 0) {
      const title = await page.title().catch(() => "");
      const anchorCount = await page.locator("a").count().catch(() => -1);
      throw new Error(
        `EMPTY_RENDER ${source} title="${title.slice(0, 80)}" url="${page.url().slice(0, 120)}" html=${Math.round(html.length / 1024)}kb anchors=${anchorCount} jobLinks=0`
      );
    }
    const seen = new Set<string>();
    const out: ScrapedJob[] = [];
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
      out.push({
        externalId: `${source}-${uuid}`,
        title: titleGuess,
        company,
        location: "Remote",
        url: l.href,
        description: "",
      });
      if (out.length >= 15) break;
    }
    // Log 1 baris per run agar cukup docker logs | grep jobs.
    console.log(`[jobs] ${source} "${keyword}" links=${out.length} html=${Math.round(html.length / 1024)}kb`);
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
