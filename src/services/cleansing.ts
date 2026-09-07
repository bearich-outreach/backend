// Data cleansing Fase 2: buang PSTN, format 628xx
const LANDLINE_PREFIXES = ["021","022","024","031","061","0751","0752","0361","0274","031"];

export function normalizePhone(raw?: string): string | null {
  if (!raw) return null;
  let s = String(raw).replace(/[^0-9+]/g, "");
  s = s.replace(/^\+/, "");
  // 0xxx -> 62xxx, 62xxx keep, 8xxx -> 628xxx
  if (s.startsWith("0")) s = "62" + s.slice(1);
  if (s.startsWith("8")) s = "62" + s;
  if (!/^628\d{8,12}$/.test(s)) return null;
  // landline: 6221... (Jakarta) etc — discard if starts with 6221, 6222, etc
  for (const prefix of LANDLINE_PREFIXES) {
    const p62 = "62" + prefix.slice(1);
    if (s.startsWith(p62)) return null;
  }
  return s;
}

export function isClosedStatus(mapsStatus?: string): boolean {
  return String(mapsStatus).toUpperCase().includes("CLOSED");
}
