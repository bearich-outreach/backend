import { Prospect } from "./types";

export function uid(prefix = ""): string {
  return (
    prefix +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 8)
  );
}

export function todayISO(): string {
  return new Date().toISOString();
}

export function addDaysISO(days: number, from = new Date()): string {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

export function createProspect(input: Partial<Prospect>): Prospect {
  const now = todayISO();
  return {
    id: uid("p_"),
    name: input.name ?? "Unnamed",
    company: input.company ?? "",
    channel: input.channel ?? "linkedin",
    contact: input.contact ?? "",
    segment: input.segment ?? "",
    notes: input.notes ?? "",
    status: "new",
    createdAt: now,
    lastContactAt: undefined,
    nextFollowUpAt: now,
    followUpStep: 0,
  };
}