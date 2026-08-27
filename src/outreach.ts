import { Activity, Prospect, ProspectStatus } from "./types";
import { addDaysISO, todayISO, uid } from "./store";
import { addActivity, updateProspect, getProspect } from "./db";

export function computeNextStep(
  p: Prospect,
  seq: { delayDays: number }[]
): number {
  return Math.min(p.followUpStep, Math.max(0, seq.length - 1));
}

export async function advanceProspect(
  prospectId: string,
  opts: { message?: string; seq: { delayDays: number }[] }
): Promise<Prospect | undefined> {
  const p = await getProspect(prospectId);
  if (!p) return undefined;

  const now = todayISO();
  const next = computeNextStep(p, opts.seq);

  const updated = {
    ...p,
    lastContactAt: now,
    followUpStep: next + 1,
    status: p.status === "new" ? ("contacted" as ProspectStatus) : p.status,
    nextFollowUpAt:
      next + 1 >= opts.seq.length
        ? undefined
        : addDaysISO(opts.seq[next + 1].delayDays, new Date()),
  };

  await updateProspect(prospectId, updated);
  await addActivity(prospectId, "sent", opts.message);
  return updated;
}

export async function setStatus(
  prospectId: string,
  status: ProspectStatus,
  opts: { note?: string; value?: number } = {}
): Promise<Prospect | undefined> {
  const p = await getProspect(prospectId);
  if (!p) return undefined;

  const now = todayISO();
  const updated: Prospect = { ...p, status };

  if (status === "closed") {
    updated.closedAt = now;
    if (opts.value !== undefined) updated.closedValue = opts.value;
    updated.nextFollowUpAt = undefined;
  }
  if (status === "dead") {
    updated.nextFollowUpAt = undefined;
  }
  if (status === "replied" || status === "interested") {
    updated.nextFollowUpAt = undefined;
  }

  await updateProspect(prospectId, updated);
  await addActivity(
    prospectId,
    status as Activity["type"],
    opts.note
  );
  return updated;
}

export async function logNote(prospectId: string, note: string): Promise<void> {
  await addActivity(prospectId, "note", note);
}

export function exportCsv(prospects: Prospect[]): string {
  const header = [
    "name",
    "company",
    "channel",
    "contact",
    "segment",
    "status",
    "followUpStep",
    "lastContactAt",
    "nextFollowUpAt",
    "closedValue",
    "notes",
  ];
  const rows = prospects.map((p) =>
    header
      .map((h) => {
        const v = (p as unknown as Record<string, unknown>)[h];
        const str = v === undefined || v === null ? "" : String(v);
        return `"${str.replaceAll('"', '""')}"`;
      })
      .join(",")
  );
  return [header.join(","), ...rows].join("\n");
}

function parseCsvCells(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

export function parseCsv(csv: string): Prospect[] {
  const rows: string[] = [];
  let currentRow = "";
  let inQuotes = false;
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i];
    if (char === '"') {
      if (inQuotes && csv[i + 1] === '"') {
        currentRow += '""';
        i++;
      } else {
        inQuotes = !inQuotes;
        currentRow += char;
      }
    } else if ((char === "\n" || (char === "\r" && csv[i + 1] === "\n")) && !inQuotes) {
      if (char === "\r") i++;
      if (currentRow.trim()) rows.push(currentRow);
      currentRow = "";
    } else {
      currentRow += char;
    }
  }
  if (currentRow.trim()) rows.push(currentRow);

  if (rows.length < 2) return [];

  const headers = parseCsvCells(rows[0]).map((h) => h.toLowerCase().replace(/^"|"$/g, ""));

  return rows
    .slice(1)
    .map((line): Prospect => {
      const cells = parseCsvCells(line);
      const row: Record<string, string> = {};
      headers.forEach((h, i) => {
        row[h] = cells[i] ?? "";
      });
      return {
        id: uid("p_"),
        name: row.name || "Unnamed",
        company: row.company ?? "",
        channel: row.channel || "linkedin",
        contact: row.contact ?? "",
        segment: row.segment ?? "",
        notes: row.notes ?? "",
        status: "new",
        createdAt: todayISO(),
        followUpStep: 0,
        nextFollowUpAt: todayISO(),
      };
    })
    .filter((p) => p.name !== "Unnamed" || p.contact !== "");
}