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

  const envKey = process.env.DEEPSEEK_API_KEY?.trim() || "";
  const apiKey = envKey || settings.apiKey?.trim() || "";
  const baseUrl = process.env.DEEPSEEK_BASE_URL?.trim() || settings.baseUrl;
  const model = process.env.DEEPSEEK_MODEL?.trim() || settings.model;
  // Kuota harian real (0 = tanpa batas). Gagal/error tidak memakan kuota.
  const limitRaw = Number(process.env.DAILY_DEEPSEEK_LIMIT ?? 15);
  const aiLimit = Number.isFinite(limitRaw) ? limitRaw : 15;
  const todayWIB = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" })).toISOString().slice(0, 10);
  let aiUsed = 0;
  if (settings.provider === "deepseek" && Boolean(apiKey) && aiLimit !== 0) {
    try {
      const { getDeepseekDailyCount } = await import("../db");
      aiUsed = await getDeepseekDailyCount(todayWIB);
    } catch { aiUsed = 0; }
  }
  const useAI = settings.provider === "deepseek" && Boolean(apiKey) && (aiLimit <= 0 || aiUsed < aiLimit);

  if (!useAI) {
    const spintaxBase = `{Halo|Hai} ${raw.name} di ${raw.city}, {saya|kami} dari ${settings.businessName} bantu ${raw.category} bikin website modern. ${filled} {Minat?|Boleh diskusi?}`;
    const variants = [expandSpintax(spintaxBase), expandSpintax(spintaxBase), expandSpintax(spintaxBase)];
    return { message: variants[0], variants };
  }

  try {
    const prompt = `Buat pesan WA singkat (max 120 kata) untuk ${raw.name} (${raw.category} di ${raw.city}, rating ${raw.rating}, ${raw.reviewCount} ulasan). Tawarkan ${settings.businessName}: ${settings.services.join(", ")}. Variasi spintax ringan. Hanya teks pesan.`;
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7,
        max_tokens: 300,
      }),
    });
    if (!res.ok) {
      if (res.status === 402 || res.status === 429 || res.status === 401) {
        try {
          const { saveSettings } = await import("../db");
          await saveSettings({ ...settings, provider: "none" });
        } catch {}
      }
      throw new Error(`ai fail ${res.status}`);
    }
    const data = await res.json() as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("empty");
    try {
      const { incrDeepseekDailyCount } = await import("../db");
      await incrDeepseekDailyCount(todayWIB);
    } catch { /* counter best-effort */ }
    const variants = [content, expandSpintax(content), expandSpintax(content)];
    return { message: content, variants };
  } catch {
    const sp = `{Halo|Hai} ${raw.name}, ${filled}`;
    return { message: expandSpintax(sp), variants: [expandSpintax(sp)] };
  }
}
