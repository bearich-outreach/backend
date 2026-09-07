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
}
