import cron from "node-cron";
import { getQualifiedLeads, updateQualifiedLead, getDailyCount, incrDailyCount } from "../db";
import { sendWA } from "../services/waVerify";
import { insertWebhookLog } from "../db";

function isWIBOperational(): boolean {
  // WIB = UTC+7
  const now = new Date();
  const wib = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
  const day = wib.getDay(); // 0 Sun, 6 Sat
  if (day === 0 || day === 6) return false;
  const hour = wib.getHours();
  return hour >= 9 && hour < 16;
}

function randomDelayMs(): number {
  const min = 30 * 60 * 1000, max = 50 * 60 * 1000;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

let lastSentAt = 0;

export async function tickScheduler() {
  if (!isWIBOperational()) return;
  const todayWIB = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" })).toISOString().slice(0,10);
  const count = await getDailyCount(todayWIB);
  if (count >= 10) return;
  const now = Date.now();
  if (lastSentAt && now - lastSentAt < randomDelayMs()) return; // throttle 30-50m random window
  const leads = await getQualifiedLeads({ status: "New Lead", limit: 10 });
  if (!leads.length) return;
  // pick highest score
  const lead = leads[0];
  const dry = String(process.env.AUTOPILOT_DRY_RUN || "true").toLowerCase() === "true";
  const text = lead.message || `Halo ${lead.name} di ${lead.city}, kami Bearich bantu ${lead.category} bikin website.`;
  if (dry) {
    await updateQualifiedLead(lead.id, { status: "Contacted", contactedAt: new Date().toISOString() });
    await insertWebhookLog(lead.phone628, "dry_run_send", { leadId: lead.id, text });
    lastSentAt = now;
    await incrDailyCount(todayWIB);
    return;
  }
  const ok = await sendWA(lead.phone628, text);
  if (ok) {
    await updateQualifiedLead(lead.id, { status: "Contacted", contactedAt: new Date().toISOString() });
    await incrDailyCount(todayWIB);
    lastSentAt = now;
  }
}

export function startScheduler() {
  // check every minute
  cron.schedule("* * * * *", () => { tickScheduler().catch(()=>{}); });
  // buffer ensure every 10 minutes (auto-refill)
  cron.schedule("*/10 * * * *", async () => {
    const { ensureBuffer } = await import("./scraper");
    ensureBuffer().catch(()=>{});
  });
  // prune raw junk >180d daily at 02:00 WIB (handled via manual SQL if needed)
}
