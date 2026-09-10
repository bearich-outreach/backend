// Scoring jobs: full remote, tanpa filter skill/gaji/kontrak.
// Semua tetap masuk listings — skor hanya untuk urutan (sort newest + relevansi role).
// Senior / mobile / java / spring / golang kena penalti, intern/junior dapat bonus.

const ROLE_VARIANTS = [
  "backend", "frontend", "fullstack", "web developer", "software engineer",
  "node", "react", "vue", "angular", "laravel", "django", "python", "php",
  "api developer", "devops", "wordpress", "cms", "qa engineer", "qa automation",
];

const NEGATIVE = [
  "senior", "sr.", "sr ", "lead", "principal", "manager", "head",
  "mobile", "flutter", "react native", "android", "ios", "swift", "kotlin",
  "java", "spring", "golang", "desktop",
];

const JUNIOR_BONUS = ["intern", "junior", "fresh graduate", "associate", "staff"];

export interface JobScoreInput {
  title: string;
  description?: string;
  postedDate?: string;
}

export function scoreJob(input: JobScoreInput): number {
  const t = `${input.title} ${input.description ?? ""}`.toLowerCase();
  let score = 0;

  // +50 relevansi role
  const titleLow = input.title.toLowerCase();
  if (ROLE_VARIANTS.some((v) => titleLow.includes(v))) score += 50;
  else score += 15; // judul polos tetap dapat poin kecil

  // +30 freshness (posted date)
  if (input.postedDate) {
    const d = new Date(input.postedDate).getTime();
    if (!isNaN(d)) {
      const days = (Date.now() - d) / (1000 * 60 * 60 * 24);
      if (days <= 3) score += 30;
      else if (days <= 7) score += 20;
      else if (days <= 14) score += 10;
    }
  } else {
    score += 5; // tanggal tak diketahui
  }

  // +20 bonus deskripsi (gaji disclosed / remote keyword / verified)
  if (/rp|idr|salary|gaji/i.test(t)) score += 5;
  if (/remote|wfh|work from home|dari rumah/i.test(t)) score += 10;
  if (/verified|actively hiring/i.test(t)) score += 5;

  // bonus junior
  if (JUNIOR_BONUS.some((k) => t.includes(k))) score += 10;

  // penalti senior / mobile / desktop stack
  if (NEGATIVE.some((k) => t.includes(k))) score -= 50;

  return Math.max(0, Math.min(100, score));
}

export type RemoteLabel = "Remote" | "Perlu Cek";

/**
 * Klasifikasi arrangement dari teks bebas (lokasi + deskripsi + judul).
 * Kenali label Indonesia Glints: "Kerja di lokasi" (onsite),
 * "Kerja di lokasi / rumah" (hybrid), "Remote/dari rumah" (remote).
 * Urutan penting: hybrid dicek dulu karena mengandung frasa "kerja di lokasi".
 */
export function detectRemoteLabel(location: string, description: string): { label: RemoteLabel; reviewFlag: boolean } {
  const text = `${location} ${description}`;
  const isHybrid = /kerja di lokasi\s*\/\s*rumah|hybrid/i.test(text);
  if (isHybrid) return { label: "Perlu Cek", reviewFlag: true };
  const hasRemote = /remote\/dari rumah|remote\/wfh|\bremote\b|\bwfh\b|work from home|fully remote|kerja remote|dari rumah/i.test(text);
  // Catatan: nama kota TIDAK dipakai sebagai sinyal onsite — lowongan remote
  // sering mencantumkan kota domisili perusahaan. Sinyal onsite hanya dari
  // badge/frasa eksplisit. Yang tak terbukti remote default-nya Perlu Cek
  // (= ditolak worker), jadi celah ini aman.
  const hasOnsite = /kerja di lokasi|onsite|on-site|\bwfo\b|hadir ke kantor|penempatan/i.test(text);
  if (hasRemote && !hasOnsite) return { label: "Remote", reviewFlag: false };
  if (hasRemote && hasOnsite) return { label: "Perlu Cek", reviewFlag: true };
  if (!hasRemote && hasOnsite) return { label: "Perlu Cek", reviewFlag: true };
  // tidak jelas -> flag review (worker memutuskan: tidak masuk listings)
  return { label: "Perlu Cek", reviewFlag: true };
}
