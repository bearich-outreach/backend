import { insertJobTarget, countJobTargets, getJobTargets } from "../db";
import { uid, todayISO } from "../store";

// 3 query global untuk trial OpenWebNinja (1 request API per keyword).
// Terpisah dari 63 target Playwright; dikerjakan worker harian khusus (ownWorker).
export const OWN_QUERIES = [
  "remote frontend developer",
  "remote backend developer",
  "remote fullstack developer",
];

export async function seedOwnTargets(): Promise<{ inserted: number; total: number }> {
  const existing = await getJobTargets({ limit: 500 });
  const have = new Set(existing.map((t) => `${t.keyword}||${t.source}`));
  let inserted = 0;
  const now = todayISO();
  for (const q of OWN_QUERIES) {
    if (have.has(`${q}||openwebninja`)) continue;
    await insertJobTarget({
      id: uid("jt_"),
      keyword: q,
      source: "openwebninja",
      status: "PENDING",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
    inserted++;
  }
  const after = await countJobTargets();
  return { inserted, total: after.total };
}
