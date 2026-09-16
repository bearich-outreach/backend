// Backfill riwayat skill permanen dari job_listings yang masih ada
// (termasuk hidden). Data yang sudah di-DELETE permanen tidak bisa dipulihkan.
// Jalankan: npm run backfill:skills
import { getJobListingsForBackfill, recordSkillSightings } from "../db";
import { extractSkillsWithGroups } from "../services/jobSkills";

async function main() {
  const BATCH = 500;
  let offset = 0;
  let listingsSeen = 0;
  let votes = 0;
  for (;;) {
    const rows = await getJobListingsForBackfill(BATCH, offset);
    if (!rows.length) break;
    for (const r of rows) {
      listingsSeen++;
      const found = extractSkillsWithGroups(r.title, r.description);
      if (!found.length) continue;
      votes += await recordSkillSightings({
        listingId: r.id,
        source: r.source,
        externalId: r.externalId,
        skills: found,
        seenAt: r.seenAt,
      });
    }
    offset += rows.length;
    console.log(`[backfill:skills] ${listingsSeen} listings, ${votes} votes...`);
    if (rows.length < BATCH) break;
  }
  console.log(`[backfill:skills] selesai: ${listingsSeen} listings, ${votes} votes baru.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
