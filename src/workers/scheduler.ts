import cron from "node-cron";

// Pengiriman WA otomatis DIMATIKAN: kirim hanya manual via tombol di halaman Leads
// (POST /api/apps/outreach/leads/:id/send). Scheduler di sini hanya auto-refill
// buffer scrape, tidak pernah mengirim chat.

// Deprecated no-op: dipertahankan agar import lama tidak rusak.
export async function tickScheduler(): Promise<{ manual: true }> {
  return { manual: true };
}

export function startScheduler() {
  // buffer ensure every 10 minutes (auto-refill scrape saja, bukan kirim WA)
  cron.schedule("*/10 * * * *", async () => {
    const { ensureBuffer } = await import("./scraper");
    ensureBuffer().catch(() => {});
  });
  // Jobs hunter: 1 keyword / 15 mnt, max ~10 keyword/hari via PENDING queue.
  // Gmail watcher Batch 4 menyusul terpisah — tidak ada di sini.
  if (String(process.env.JOBS_CRON_ENABLED ?? "true").toLowerCase() !== "false") {
    cron.schedule("*/15 * * * *", async () => {
      const { ensureJobBuffer } = await import("./jobScraper");
      ensureJobBuffer().catch(() => {});
    });
  }
}
