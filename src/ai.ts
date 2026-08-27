import { Prospect, Settings } from "./types";

interface Fill {
  name: string;
  company: string;
  segment: string;
  business: string;
  services: string;
}

function buildFill(p: Prospect, s: Settings): Fill {
  return {
    name: p.name,
    company: p.company || p.segment || "bisnis Anda",
    segment: p.segment || p.company || "bisnis Anda",
    business: s.businessName,
    services: s.services.join(", "),
  };
}

export function fillTemplate(template: string, fill: Fill): string {
  return template
    .replaceAll("{name}", fill.name)
    .replaceAll("{company}", fill.company)
    .replaceAll("{segment}", fill.segment)
    .replaceAll("{business}", fill.business)
    .replaceAll("{services}", fill.services);
}

export function fallbackTemplate(p: Prospect, s: Settings, step: number): string {
  const t = s.sequence[step]?.template ?? s.sequence[s.sequence.length - 1]?.template ?? "";
  return fillTemplate(t, buildFill(p, s));
}

export async function generateMessage(
  p: Prospect,
  s: Settings,
  step: number
): Promise<{ message: string; usedAI: boolean }> {
  const fill = buildFill(p, s);
  const fallback = fillTemplate(
    s.sequence[step]?.template ?? s.sequence[s.sequence.length - 1]?.template ?? "",
    fill
  );

  if (s.provider === "none" || !s.apiKey.trim()) {
    return { message: fallback, usedAI: false };
  }

  try {
    const systemPrompt = `Kamu adalah asisten penulisan pesan penjualan B2B yang personal dan natural dalam Bahasa Indonesia. Tulis pesan outreach singkat (maks 120 kata) yang personal untuk calon klien freelance web developer.

Profil pengirim (developer): ${s.businessName}. Layanan: ${s.services.join(", ")}.
Prospek: nama ${p.name}, perusahaan ${p.company || "-"}, bidang ${p.segment || "-"}.
Ini adalah langkah follow-up ke-${step + 1} dari total ${s.sequence.length} langkah. Pesan pertama memperkenalkan layanan; follow-up berikutnya singkat & tidak memaksa.

Hasilkan HANYA teks pesan, tanpa kutipan, tanpa judul.`;

    const body = {
      model: s.model,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Tulis pesan follow-up ke-${step + 1} untuk ${p.name}.`,
        },
      ],
      temperature: 0.7,
      max_tokens: 300,
    };

    const res = await fetch(
      `${s.baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${s.apiKey}`,
        },
        body: JSON.stringify(body),
      }
    );

    if (!res.ok) {
      return { message: fallback, usedAI: false };
    }

    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return { message: fallback, usedAI: false };
    return { message: content, usedAI: true };
  } catch {
    return { message: fallback, usedAI: false };
  }
}