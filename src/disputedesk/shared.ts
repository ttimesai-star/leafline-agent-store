// Vendored from DisputeDesk (github.com/ttimesai-star/disputedesk, MIT, same author) - keep in sync by hand.
// API contract shared by the server and the React app (types only).
import type { AcceptClaimType, Dispute, DisputeReason, Evidence, Money } from "./types.ts";

export type Recommendation = "FIGHT" | "ACCEPT" | "MESSAGE_BUYER" | "WAIT";

export interface TimelineEvent {
  at: string;
  kind: "payment" | "order" | "shipment" | "delivery" | "return" | "refund" | "message" | "dispute" | "evidence" | "deadline" | "resolution";
  title: string;
  detail?: string;
  source: "orders" | "transactions" | "tracking" | "disputes";
}

export interface CaseFacts {
  amount: number;
  currency: string;
  reason: DisputeReason;
  stage: string;
  channel: string;
  status: string;
  daysToDue: number | null;
  digital: boolean;
  hasTracking: boolean;
  delivered: boolean;
  inTransit: boolean;
  returned: boolean;
  carrier: string | null;
  trackingNumbers: string[];
  refundIds: string[];
  addressConfirmed: boolean;
  protectionEligible: boolean;
  itemDescription: string | null;
  buyerMessages: number;
  sellerReplied: boolean;
  orderId: string | null;
}

export interface Assessment {
  recommendation: Recommendation;
  /** 0..1, estimated chance the seller wins if they fight */
  winProbability: number;
  rationale: string[];
  riskFlags: string[];
  evidence: Evidence[];
  buyerMessage: string;
  acceptNote: string;
  acceptType: AcceptClaimType | null;
  /** Expected outcome in dispute currency: fighting vs. accepting now */
  expected: { fight: number; accept: number; assumedFee: number };
  source: "llm" | "rules";
  model: string | null;
  llmError?: string;
  generatedAt: string;
}

export interface DisputeRow {
  disputeId: string;
  amount: number;
  currency: string;
  reason: DisputeReason;
  status: string;
  stage: string;
  channel: string;
  buyer: string;
  item: string;
  createdAt: string;
  dueAt: string | null;
  dueInDays: number | null;
  winScore: number | null;
  recommendation: Recommendation | null;
  assessedBy: "llm" | "rules" | null;
  sellerTransactionId: string | null;
}

export interface CaseView {
  dispute: Dispute;
  facts: CaseFacts;
  timeline: TimelineEvent[];
  assessment: Assessment | null;
  dataGaps: string[];
}

export interface Policy {
  id: string;
  name: string;
  enabled: boolean;
  /** Only disputes at or below this amount */
  maxAmount: number;
  /** Empty = any reason */
  reasons: DisputeReason[];
  /** Only when estimated win probability is at or below this (0..1) */
  maxWinProbability: number;
  action: "ACCEPT" | "MESSAGE_BUYER";
  /** Log what would happen without calling PayPal */
  dryRun: boolean;
}

export interface PolicySettings {
  /** Global kill switch for every automatic action */
  autopilot: boolean;
  /** Cap on money the agent may refund automatically per UTC day */
  dailyAutoAcceptLimit: number;
  policies: Policy[];
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: "agent" | "seller" | "webhook" | "system";
  action: string;
  disputeId: string | null;
  outcome: "ok" | "error" | "dry-run" | "skipped";
  detail: string;
  amount?: Money;
}

export type GridFilter =
  | { filterType: "number"; type: "equals" | "notEqual" | "lessThan" | "lessThanOrEqual" | "greaterThan" | "greaterThanOrEqual" | "inRange"; filter: number; filterTo?: number }
  | { filterType: "text"; type: "equals" | "notEqual" | "contains" | "notContains" | "startsWith"; filter: string }
  | { filterType: "text"; operator: "OR"; conditions: { filterType: "text"; type: "equals" | "contains"; filter: string }[] };

export interface QueryResult {
  filterModel: Record<string, GridFilter>;
  sort: { colId: string; sort: "asc" | "desc" } | null;
  explanation: string;
  source: "llm" | "rules";
}

export interface HealthInfo {
  ok: true;
  paypal: "mock" | "sandbox";
  llm: string[];
  toolkit: boolean;
}
