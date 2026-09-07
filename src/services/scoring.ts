import { RawLead } from "../types";

export function scoreLead(raw: RawLead, waVerified: boolean): number {
  let s = 0;
  if (!raw.website) s += 40;
  if ((raw.reviewCount ?? 0) > 50) s += 30;
  if ((raw.rating ?? 0) >= 4.5) s += 15;
  if (waVerified) s += 15;
  return s;
}
