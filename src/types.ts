export type ProspectStatus =
  | "new"
  | "contacted"
  | "replied"
  | "interested"
  | "closed"
  | "dead";

export const STATUS_LABELS: Record<ProspectStatus, string> = {
  new: "New",
  contacted: "Contacted",
  replied: "Replied",
  interested: "Interested",
  closed: "Closed",
  dead: "Dead",
};

export const STATUS_ORDER: ProspectStatus[] = [
  "new",
  "contacted",
  "replied",
  "interested",
  "closed",
  "dead",
];

export interface Prospect {
  id: string;
  name: string;
  company?: string;
  channel: string;
  contact?: string;
  segment?: string;
  notes?: string;
  status: ProspectStatus;
  createdAt: string;
  lastContactAt?: string;
  nextFollowUpAt?: string;
  followUpStep: number;
  closedAt?: string;
  closedValue?: number;
}

export interface Activity {
  id: string;
  prospectId: string;
  type:
    | "sent"
    | "replied"
    | "interested"
    | "closed"
    | "dead"
    | "note"
    | "ai_generated";
  message?: string;
  createdAt: string;
}

export interface SequenceStep {
  id: string;
  delayDays: number;
  template: string;
}

export interface Settings {
  businessName: string;
  services: string[];
  segmentFocus: string;
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  weeklyTarget: number;
  sequence: SequenceStep[];
}

export interface Database {
  prospects: Prospect[];
  activities: Activity[];
  settings: Settings;
}