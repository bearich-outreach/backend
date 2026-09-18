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

export interface ScorePart {
  key: string;
  label: string;
  points: number;
}

export interface ScoreBreakdown {
  score: number;
  parts: ScorePart[];
}

export function scoreJobDetailed(input: JobScoreInput): ScoreBreakdown {
  const t = `${input.title} ${input.description ?? ""}`.toLowerCase();
  const parts: ScorePart[] = [];

  // +50 relevansi role
  const titleLow = input.title.toLowerCase();
  const roleHit = ROLE_VARIANTS.find((v) => titleLow.includes(v));
  if (roleHit) {
    parts.push({ key: "role", label: `Judul relevan (${roleHit})`, points: 50 });
  } else {
    parts.push({ key: "role", label: "Judul umum", points: 15 });
  }

  // +30 freshness (posted date)
  if (input.postedDate) {
    const d = new Date(input.postedDate).getTime();
    if (!isNaN(d)) {
      const days = (Date.now() - d) / (1000 * 60 * 60 * 24);
      if (days <= 3) parts.push({ key: "freshness", label: "Diposting ≤ 3 hari lalu", points: 30 });
      else if (days <= 7) parts.push({ key: "freshness", label: "Diposting ≤ 7 hari lalu", points: 20 });
      else if (days <= 14) parts.push({ key: "freshness", label: "Diposting ≤ 14 hari lalu", points: 10 });
      else parts.push({ key: "freshness", label: "Diposting > 14 hari lalu", points: 0 });
    } else {
      parts.push({ key: "freshness", label: "Tanggal tak valid", points: 0 });
    }
  } else {
    parts.push({ key: "freshness", label: "Tanggal tak diketahui", points: 5 });
  }

  // +20 bonus deskripsi (gaji disclosed / remote keyword / verified)
  if (/rp|idr|salary|gaji/i.test(t)) parts.push({ key: "salary", label: "Gaji tercantum", points: 5 });
  if (/remote|wfh|work from home|dari rumah/i.test(t)) parts.push({ key: "remote", label: "Keyword remote di deskripsi", points: 10 });
  if (/verified|actively hiring/i.test(t)) parts.push({ key: "active", label: "Sinyal aktif", points: 5 });

  // bonus junior
  const juniorHit = JUNIOR_BONUS.find((k) => t.includes(k));
  if (juniorHit) parts.push({ key: "junior", label: `Junior (${juniorHit})`, points: 10 });

  // penalti senior / mobile / desktop stack
  const negHit = NEGATIVE.find((k) => t.includes(k));
  if (negHit) parts.push({ key: "penalty", label: `Mengandung kata "${negHit}"`, points: -50 });

  const raw = parts.reduce((s, p) => s + p.points, 0);
  const score = Math.max(0, Math.min(100, raw));
  if (score !== raw) {
    parts.push({ key: "clamp", label: "Penyesuaian batas 0–100", points: score - raw });
  }
  return { score, parts };
}

export function scoreJob(input: JobScoreInput): number {
  return scoreJobDetailed(input).score;
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
