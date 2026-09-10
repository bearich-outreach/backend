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
    });
    const url = source === "glints"
      ? `https://glints.com/id/opportunities?query=${encodeURIComponent(keyword)}&workArrangement=REMOTE&sortBy=LATEST`
      : `https://id.jobstreet.com/id/${encodeURIComponent(keyword.replace(/\s+/g, "-").toLowerCase())}-jobs?where=Remote&sortmode=ListedDate`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(2000 + Math.random() * 3000);
    const html = await page.content();
    const lower = html.toLowerCase();
    if (lower.includes("captcha") || lower.includes("unusual traffic") || lower.includes("verify you are human")) {
      throw new Error("captcha: block terdeteksi di " + source);
    }
    // Ekstraksi generik anchor lowongan (best-effort, tidak rapuh ke 1 selector).
    const links = await page.$$eval("a[href*='/jobs/'], a[href*='/job/'], a[href*='/opportunities/']", (els) =>
      els.slice(0, 15).map((a) => ({
        href: (a as HTMLAnchorElement).href,
        text: (a.textContent || "").trim().slice(0, 200),
      }))
    );
    const seen = new Set<string>();
    const out: ScrapedJob[] = [];
    for (const l of links) {
      if (!l.href || seen.has(l.href)) continue;
      seen.add(l.href);
      const idMatch = l.href.match(/([0-9a-f-]{8,}|[0-9]{6,})/i);
      out.push({
        externalId: idMatch ? `${source}-${idMatch[1]}` : `${source}-${Buffer.from(l.href).toString("base64").slice(0, 24)}`,
        title: l.text || keyword,
        company: "",
        location: "Remote",
        url: l.href,
        description: "",
      });
      if (out.length >= 15) break;
    }
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
