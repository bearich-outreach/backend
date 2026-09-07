import { RawLead, Settings } from "../types";
import { expandSpintax } from "./spintax";

// DeepSeek + Spintax Fase 3 untuk qualified leads S>=70
export async function generateQualifiedMessage(raw: RawLead, settings: Settings): Promise<{ message: string; variants: string[] }> {
  const base = settings.sequence[0]?.template || "Halo {name} dari {city}, kami {business} bantu {category} bikin website. {Ketik STOP untuk berhenti}";
  const filled = base
    .replaceAll("{name}", raw.name)
    .replaceAll("{company}", raw.name)
    .replaceAll("{city}", raw.city || "")
    .replaceAll("{category}", raw.category || "")
    .replaceAll("{business}", settings.businessName)
    .replaceAll("{services}", settings.services.join(", "))
    .replaceAll("{rating}", String(raw.rating ?? ""))
    .replaceAll("{reviewCount}", String(raw.reviewCount ?? ""));

  const dailyLimit = Number(process.env.DAILY_DEEPSEEK_LIMIT || 15);
  // simple in-mem counter handled by caller; here just try DeepSeek if key exists
  const useAI = settings.provider !== "none" && Boolean(settings.apiKey?.trim()) && dailyLimit > 0;

  if (!useAI) {
    const spintaxBase = `{Halo|Hai} ${raw.name} di ${raw.city}, {saya|kami} dari ${settings.businessName} bantu ${raw.category} bikin website modern. ${filled} {Minat?|Boleh diskusi?}`;
    const variants = [expandSpintax(spintaxBase), expandSpintax(spintaxBase), expandSpintax(spintaxBase)];
    return { message: variants[0], variants };
  }

  try {
    const prompt = `Buat pesan WA singkat (max 120 kata) untuk ${raw.name} (${raw.category} di ${raw.city}, rating ${raw.rating}, ${raw.reviewCount} ulasan). Tawarkan ${settings.businessName}: ${settings.services.join(", ")}. Variasi spintax ringan. Hanya teks pesan.`;
    const res = await fetch(`${settings.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify({
        model: settings.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7,
        max_tokens: 300,
      }),
    });
    if (!res.ok) throw new Error("ai fail");
    const data = await res.json() as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("empty");
    const variants = [content, expandSpintax(content), expandSpintax(content)];
    return { message: content, variants };
  } catch {
    const sp = `{Halo|Hai} ${raw.name}, ${filled}`;
    return { message: expandSpintax(sp), variants: [expandSpintax(sp)] };
  }
}
