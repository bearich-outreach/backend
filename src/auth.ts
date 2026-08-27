const COOKIE = "bo_session";
const TTL_SECONDS = 60 * 60 * 24 * 7;

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(value: string): Uint8Array {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function enc(value: string): string {
  return bytesToB64url(new TextEncoder().encode(value));
}

function dec(value: string): string {
  return new TextDecoder().decode(b64urlToBytes(value));
}

async function hmac(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data)
  );
  return bytesToB64url(new Uint8Array(sig));
}

export async function createToken(username: string): Promise<string> {
  const payload = enc(JSON.stringify({ u: username, exp: Date.now() + TTL_SECONDS * 1000 }));
  const sig = await hmac(payload, process.env.SESSION_SECRET ?? "");
  return `${payload}.${sig}`;
}

export async function verifyToken(token: string): Promise<boolean> {
  const secret = process.env.SESSION_SECRET ?? "";
  if (!secret) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const expected = await hmac(payload, secret);
  if (expected !== sig) return false;
  try {
    const data = JSON.parse(dec(payload)) as { u?: string; exp?: number };
    if (!data.u) return false;
    if (typeof data.exp === "number" && data.exp < Date.now()) return false;
    return true;
  } catch {
    return false;
  }
}

export function credentialsConfigured(): boolean {
  return Boolean(
    process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD && process.env.SESSION_SECRET
  );
}

export function checkPassword(input: string): boolean {
  const expected = process.env.ADMIN_PASSWORD ?? "";
  if (!expected || input.length !== expected.length) return false;
  const a = new TextEncoder().encode(input);
  const b = new TextEncoder().encode(expected);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export const SESSION_COOKIE = COOKIE;
export const SESSION_TTL_SECONDS = TTL_SECONDS;