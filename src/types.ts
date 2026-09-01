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

export interface App {
  id: string;
  slug: string;
  name: string;
  description?: string;
  icon?: string;
  enabled: boolean;
  createdAt: string;
}

export interface AppCredential {
  id: string;
  appId: string;
  username: string;
}

export interface Database {
  prospects: Prospect[];
  activities: Activity[];
  settings: Settings;
}

export type TransactionType = "in" | "out";

export type AccountType = "tunai" | "ewallet" | "rekening" | "lainnya";

export interface CashflowAccount {
  id: string;
  name: string;
  type: AccountType;
  createdAt: string;
}

export const ACCOUNT_TYPES: Record<AccountType, string> = {
  tunai: "Tunai",
  ewallet: "E-Wallet",
  rekening: "Rekening",
  lainnya: "Lainnya",
};

export interface Transaction {
  id: string;
  type: TransactionType;
  amount: number;
  category: string;
  account: string;
  description?: string;
  date: string;
  createdAt: string;
}

export interface AccountBalance {
  account: string;
  balance: number;
}

export interface CashflowSettings {
  targetAmount: number;
  targetType: "saving";
}

export interface CashflowSummary {
  totalIn: number;
  totalOut: number;
  balance: number;
  countIn: number;
  countOut: number;
  byCategory: Record<string, number>;
  perAccount: AccountBalance[];
}

export const CASHFLOW_CATEGORIES = [
  "Gaji",
  "Proyek",
  "Bonus",
  "Makanan",
  "Transport",
  "Tagihan",
  "Belanja",
  "Lainnya",
] as const;

export interface Note {
  id: string;
  title: string;
  content: string;
  tags: string[];
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}