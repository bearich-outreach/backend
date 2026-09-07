// Verifikasi WA via Evolution API
export async function verifyWA(phone628: string): Promise<boolean> {
  const url = process.env.WA_GATEWAY_URL;
  const key = process.env.WA_GATEWAY_KEY;
  const instance = process.env.WA_INSTANCE || "bearich-wa1";
  if (!url || !key) return false;
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/chat/whatsappNumbers/${instance}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key },
      body: JSON.stringify({ numbers: [phone628] }),
    });
    if (!res.ok) return false;
    const data = await res.json() as { exists?: boolean } | Array<{ exists?: boolean; jid?: string }>;
    if (Array.isArray(data)) return Boolean(data[0]?.exists);
    return Boolean((data as { exists?: boolean }).exists);
  } catch {
    return false;
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
