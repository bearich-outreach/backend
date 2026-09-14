import { insertJobTarget, countJobTargets, getJobTargets } from "../db";
import { uid, todayISO } from "../store";
import type { JobSource } from "../types";

// 21 role web only (tanpa kata Remote di keyword — filter remote via query + verifikasi detail).
// Mobile / Java / Spring / Golang / Senior dicoret via negative list di scoring.
export const JOB_ROLES = [
  "Backend Developer",
  "Backend Engineer",
  "Frontend Engineer",
  "Frontend Developer",
  "Fullstack Developer",
  "Fullstack Engineer",
  "Web Developer",
  "Software Engineer Web",
  "Junior Web Developer",
  "Intern Web Developer",
  "Node.js Developer",
  "React Developer",
  "Vue.js Developer",
  "Angular Developer",
  "PHP Laravel Developer",
  "Python Django Developer",
  "API Developer",
  "DevOps Intern",
  "WordPress Developer",
  "PHP CMS Web",
  "QA Engineer Web",
];

const SOURCES: JobSource[] = ["glints", "jobstreet", "indeed"];

export async function seedJobTargets(): Promise<{ inserted: number; total: number }> {
  // Tambah yang hilang saja (idempotent): 42 lama tidak disentuh updated_at-nya
  // agar urutan putar ulang DONE tidak ke-reset. Total docita 21 x 3 = 63.
  const existing = await getJobTargets({ limit: 500 });
  const have = new Set(existing.map((t) => `${t.keyword}||${t.source}`));
  let inserted = 0;
  const now = todayISO();
  for (const role of JOB_ROLES) {
    for (const source of SOURCES) {
      if (have.has(`${role}||${source}`)) continue;
      await insertJobTarget({
        id: uid("jt_"),
        keyword: role,
        source,
        status: "PENDING",
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      });
      inserted++;
    }
  }
  const after = await countJobTargets();
  return { inserted, total: after.total };
}
