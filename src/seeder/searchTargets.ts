import { REGIONS } from "./regions";
import { CATEGORIES } from "./categories";
import { insertSearchTarget, countSearchTargets } from "../db";
import { uid, todayISO } from "../store";

export async function seedSearchTargets(): Promise<{ inserted: number; total: number }> {
  const { total } = await countSearchTargets();
  if (total > 0) {
    return { inserted: 0, total };
  }
  let inserted = 0;
  const now = todayISO();
  for (const city of REGIONS) {
    for (const cat of CATEGORIES) {
      const keyword = `${cat} di ${city}`;
      await insertSearchTarget({
        id: uid("tgt_"),
        keyword,
        city,
        category: cat,
        status: "PENDING",
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      });
      inserted++;
    }
  }
  const after = await countSearchTargets();
  return { inserted, total: after.total };
}
