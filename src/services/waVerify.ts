// Verifikasi WA via Evolution API
// Tri-state: true = WA aktif, false = WA tidak aktif, null = belum pasti (gateway down/timeout/env hilang)
export async function verifyWA(phone628: string): Promise<boolean | null> {
  const url = process.env.WA_GATEWAY_URL;
  const key = process.env.WA_GATEWAY_KEY;
  const instance = process.env.WA_INSTANCE || "bearich-wa1";
  if (!url || !key) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/chat/whatsappNumbers/${instance}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key },
      body: JSON.stringify({ numbers: [phone628] }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = await res.json() as { exists?: boolean } | Array<{ exists?: boolean; jid?: string }>;
    if (Array.isArray(data)) {
      if (data.length === 0) return null;
      return Boolean(data[0]?.exists);
    }
    if (typeof (data as { exists?: boolean }).exists !== "boolean") return null;
    return Boolean((data as { exists?: boolean }).exists);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function sendWA(phone628: string, text: string): Promise<boolean> {
  const url = process.env.WA_GATEWAY_URL;
  const key = process.env.WA_GATEWAY_KEY;
  const instance = process.env.WA_INSTANCE || "bearich-wa1";
  if (!url || !key) return false;
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/message/sendText/${instance}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key },
      body: JSON.stringify({ number: phone628, text }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
