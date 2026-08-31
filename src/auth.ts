import { randomBytes, scryptSync, timingSafeEqual } from "crypto";

export const SESSION_COOKIE = "bo_session";
export const PLATFORM_COOKIE = "bh_platform";
export const APP_COOKIE_PREFIX = "bh_app_";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

const TTL_SECONDS = SESSION_TTL_SECONDS;

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

export async function createToken(
  payload: Record<string, unknown>,
  secret: string
): Promise<string> {
  const data = enc(
    JSON.stringify({ ...payload, exp: Date.now() + TTL_SECONDS * 1000 })
  );
  const sig = await hmac(data, secret);
  return `${data}.${sig}`;
}

export async function verifyToken(
  token: string,
  secret: string
): Promise<Record<string, unknown> | null> {
  if (!secret) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = await hmac(payload, secret);
  if (expected !== sig) return null;
  try {
    const data = JSON.parse(dec(payload)) as Record<string, unknown>;
    if (typeof data.exp === "number" && data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return (
    candidate.length === expected.length &&
    timingSafeEqual(candidate, expected)
  );
}

export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}

export function appCookieName(slug: string): string {
  return `${APP_COOKIE_PREFIX}${slug}`;
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