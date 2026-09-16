// Ekstraksi + peringkat skill requirement dari lowongan.
// Algoritma: taxonomy-based Document-Frequency counting.
// - Satu listing = satu vote per skill (walau disebut 5x, count tetap 1).
// - Matching pakai regex word-boundary (bukan substring polos) agar presisi.
// - Teks sumber = title + description_snippet (skill asli adanya di deskripsi,
//   judul hanya berisi role seperti "Backend Developer").

export type SkillGroup =
  | "Frontend"
  | "Backend"
  | "CMS & Commerce"
  | "Infra & Data"
  | "QA"
  | "Mobile (non-web)"
  | "Lainnya";

export interface SkillDef {
  label: string;
  group: SkillGroup;
  /** regex sudah case-insensitive; dicek berurutan, pertama menang per grup eksklusif */
  patterns: RegExp[];
  /** bila true, skill ini dikecualikan dari Top Skills web default */
  nonWeb?: boolean;
}

export interface SkillRank {
  skill: string;
  group: SkillGroup;
  count: number;
  pct: number;
}

// Urutan penting: yang lebih spesifik dulu (Next.js sebelum Node, React Native sebelum React).
export const SKILL_TAXONOMY: SkillDef[] = [
  { label: "React Native", group: "Mobile (non-web)", patterns: [/react[\s-]?native/iu], nonWeb: true },
  { label: "Flutter", group: "Mobile (non-web)", patterns: [/\bflutter\b/iu], nonWeb: true },
  { label: "Kotlin", group: "Mobile (non-web)", patterns: [/\bkotlin\b/iu], nonWeb: true },
  { label: "Swift", group: "Mobile (non-web)", patterns: [/\bswift\b(?!\s*airlines)/iu], nonWeb: true },

  { label: "Next.js", group: "Frontend", patterns: [/next[\s.]?js\b/iu] },
  { label: "Nuxt.js", group: "Frontend", patterns: [/nuxt[\s.]?js\b/iu] },
  { label: "React", group: "Frontend", patterns: [/\breact\b(?![\s-]?native)/iu, /\breactjs\b/iu, /\breact\.js\b/iu] },
  { label: "Vue.js", group: "Frontend", patterns: [/vue[\s.]?js\b/iu, /\bvue\b(?!\s*airlines)/iu] },
  { label: "Angular", group: "Frontend", patterns: [/\bangular\b/iu] },
  { label: "TypeScript", group: "Frontend", patterns: [/\btypescript\b/iu, /\bts\b(?=.*\b(javascript|frontend|react|vue|angular|node)\b)/iu] },
  { label: "JavaScript", group: "Frontend", patterns: [/\bjavascript\b/iu, /\bjs\b(?=.*\b(node|react|vue|frontend|express|nest)\b)/iu] },
  { label: "Tailwind", group: "Frontend", patterns: [/\btailwind\b/iu] },
  { label: "Redux", group: "Frontend", patterns: [/\bredux\b/iu] },
  { label: "HTML/CSS", group: "Frontend", patterns: [/\bhtml\b/iu, /\bcss\b/iu, /\bsass\b/iu, /\bscss\b/iu] },

  { label: "NestJS", group: "Backend", patterns: [/nest[\s.]?js\b/iu] },
  { label: "Node.js", group: "Backend", patterns: [/node[\s.]?js\b/iu, /\bexpress\b/iu, /\bnodejs\b/iu] },
  { label: "Laravel", group: "Backend", patterns: [/\blaravel\b/iu] },
  { label: "PHP", group: "Backend", patterns: [/\bphp\b/iu] },
  { label: "Django", group: "Backend", patterns: [/\bdjango\b/iu] },
  { label: "FastAPI", group: "Backend", patterns: [/fast[\s-]?api\b/iu] },
  { label: "Python", group: "Backend", patterns: [/\bpython\b/iu] },
  { label: "REST API", group: "Backend", patterns: [/\brest\b(?:\s*api)?/iu, /\brestful\b/iu] },
  { label: "GraphQL", group: "Backend", patterns: [/\bgraphql\b/iu] },
  { label: "Golang", group: "Backend", patterns: [/\bgolang\b/iu, /\bgo\b(?=.*\b(gin|fiber|echo|grpc|microservice)\b)/iu] },
  { label: "Java Spring", group: "Backend", patterns: [/\bspring(?:\s*boot)?\b/iu] },

  { label: "Shopify", group: "CMS & Commerce", patterns: [/\bshopify\b/iu] },
  { label: "WooCommerce", group: "CMS & Commerce", patterns: [/woo[\s-]?commerce\b/iu] },
  { label: "WordPress", group: "CMS & Commerce", patterns: [/\bwordpress\b/iu, /\bwp\b(?=.*\b(theme|plugin|elementor|woocommerce)\b)/iu] },
  { label: "Webflow", group: "CMS & Commerce", patterns: [/\bwebflow\b/iu] },

  { label: "Docker", group: "Infra & Data", patterns: [/\bdocker\b/iu] },
  { label: "AWS", group: "Infra & Data", patterns: [/\baws\b/iu, /\bamazon web services\b/iu] },
  { label: "CI/CD", group: "Infra & Data", patterns: [/\bci\s*\/\s*cd\b/iu, /\bgithub actions?\b/iu, /\bgitlab ci\b/iu, /\bjenkins\b/iu] },
  { label: "Git", group: "Infra & Data", patterns: [/\bgit\b(?!hub\s*action)/iu, /\bgithub\b/iu, /\bgitlab\b/iu] },
  { label: "MySQL", group: "Infra & Data", patterns: [/\bmysql\b/iu] },
  { label: "PostgreSQL", group: "Infra & Data", patterns: [/\bpostgres(?:ql)?\b/iu] },
  { label: "MongoDB", group: "Infra & Data", patterns: [/\bmongo(?:db)?\b/iu] },
  { label: "Firebase", group: "Infra & Data", patterns: [/\bfirebase\b/iu] },
  { label: "Supabase", group: "Infra & Data", patterns: [/\bsupabase\b/iu] },

  { label: "Selenium", group: "QA", patterns: [/\bselenium\b/iu] },
  { label: "Cypress", group: "QA", patterns: [/\bcypress\b/iu] },
  { label: "Playwright", group: "QA", patterns: [/\bplaywright\b/iu] },
  { label: "QA Automation", group: "QA", patterns: [/\bqa\b(?:\s*automation)?/iu, /\btest automation\b/iu, /\bautomation test/iu] },

  { label: "Figma", group: "Lainnya", patterns: [/\bfigma\b/iu] },
];

function normalize(text: string): string {
  return (text ?? "").toLowerCase();
}

/** Ekstrak daftar skill unik dari satu lowongan (1 listing = 1 vote per skill). */
export function extractSkills(title: string, description?: string): string[] {
  const text = normalize(`${title ?? ""}\n${description ?? ""}`);
  if (!text.trim()) return [];
  const out: string[] = [];
  for (const def of SKILL_TAXONOMY) {
    if (def.patterns.some((re) => re.test(text))) out.push(def.label);
  }
  return [...new Set(out)];
}

export interface RankInput {
  title: string;
  description?: string;
}

/**
 * Agregasi document-frequency: hitung berapa listing yang menyebut tiap skill,
 * urut count DESC. excludeNonWeb=true membuang skill Mobile agar Top Skills
 * tetap fokus web (default true sesuai positioning Job Hunter web-only).
 */
export function rankSkills(
  listings: RankInput[],
  opts: { limit?: number; excludeNonWeb?: boolean } = {}
): { total: number; skills: SkillRank[] } {
  const total = listings.length;
  const limit = Math.min(Math.max(Math.floor(Number(opts.limit) || 20), 1), 100);
  const excludeNonWeb = opts.excludeNonWeb !== false;
  const nonWebLabels = new Set(
    SKILL_TAXONOMY.filter((s) => s.nonWeb).map((s) => s.label)
  );
  const counts = new Map<string, number>();
  for (const l of listings) {
    const skills = extractSkills(l.title, l.description);
    for (const s of skills) {
      if (excludeNonWeb && nonWebLabels.has(s)) continue;
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
  }
  const groupOf = new Map(SKILL_TAXONOMY.map((s) => [s.label, s.group]));
  const skills: SkillRank[] = [...counts.entries()]
    .map(([skill, count]) => ({
      skill,
      group: groupOf.get(skill) ?? ("Lainnya" as SkillGroup),
      count,
      pct: total > 0 ? Math.round((count / total) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.count - a.count || a.skill.localeCompare(b.skill))
    .slice(0, limit);
  return { total, skills };
}
