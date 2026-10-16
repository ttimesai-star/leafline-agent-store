// DisputeDesk module inside the store: every post-purchase claim (refund request or dispute, raised by the
// buyer or by the buyer's agent) and every PayPal-side dispute gets the DisputeDesk rules assessment
// (fight / accept / message buyer / wait, win estimate, evidence draft). What the store adds on top of
// DisputeDesk: for orders placed by an AI agent, the agent journal becomes evidence - which tools the agent
// called, what product data it was shown, the buyer's spending mandate, and the fact that the buyer
// approved the payment in PayPal.
import { assessByRules } from "./rules.ts";
import { humanReason } from "./reasons.ts";
import type { Assessment, CaseFacts } from "./shared.ts";
import type { DisputeReason, Evidence } from "./types.ts";
import type { ClaimRecord, OrderRecord } from "../orders.ts";
import type { JournalEntry } from "../journal.ts";
import type { MandateView } from "../mandates.ts";
import { findProduct } from "../catalog.ts";

const DAY = 86_400_000;

export interface DeskCase {
  caseId: string;
  source: "store" | "paypal";
  kind: string;
  orderId: string | null;
  channel: "human" | "agent" | "unknown";
  reason: string;
  reasonText: string;
  amount: number;
  currency: string;
  status: string;
  createdAt: string;
  note: string;
  facts: CaseFacts;
  assessment: Assessment;
  agentEvidence: Evidence[];
  agentSummary: string | null;
}

export interface AgentContext {
  calls: JournalEntry[];
  mandate: MandateView | null;
}

/** CaseFacts for a store order. The demo shop does not ship parcels, so there is never tracking. */
export function factsForOrder(order: OrderRecord, reason: string, status: string, createdAt: string, note: string, now: Date): CaseFacts {
  const products = order.items.map((i) => findProduct(i.sku));
  const digital = products.length > 0 && products.every((p) => p?.category === "gift");
  const due = Date.parse(createdAt) + 10 * DAY;
  return {
    amount: Number(order.total),
    currency: order.currency,
    reason: reason as DisputeReason,
    stage: "INQUIRY",
    channel: "INTERNAL",
    status,
    daysToDue: Math.ceil((due - now.getTime()) / DAY),
    digital,
    hasTracking: false,
    delivered: false,
    inTransit: false,
    returned: false,
    carrier: null,
    trackingNumbers: [],
    refundIds: order.refunds.map((r) => r.refundId),
    addressConfirmed: false,
    protectionEligible: false,
    itemDescription: order.items.map((i) => `${i.quantity} x ${i.name}: ${findProduct(i.sku)?.description ?? ""}`.trim()).join("; ") || null,
    buyerMessages: note ? 1 : 0,
    sellerReplied: false,
    orderId: order.orderId,
  };
}

/** Evidence built only from the store's own journal: no invented ids, every claim traceable to a journal line. */
export function agentEvidence(order: OrderRecord, ctx: AgentContext, reason: string): { evidence: Evidence[]; summary: string | null } {
  if (order.channel !== "agent" || ctx.calls.length === 0) return { evidence: [], summary: null };
  const create = ctx.calls.find((c) => c.tool === "create_order" && c.ok && c.orderId === order.orderId);
  const searches = ctx.calls.filter((c) => c.tool === "search_products" && c.ok);
  const createsInSession = ctx.calls.filter((c) => c.tool === "create_order" && c.ok).length;
  const m = ctx.mandate;
  const lines = [
    `Order ${order.orderId} was assembled by the buyer's AI agent (session ${order.session}) through the store's WebMCP tools: ${ctx.calls.length} journaled call(s), ${searches.length} search(es) before create_order${create ? ` at ${create.ts}` : ""}.`,
    m ? `The buyer delegated a spending mandate ${m.mandateId}: budget ${m.budget} ${m.currency}${m.perOrderMax ? `, per-order max ${m.perOrderMax}` : ""}${m.categories ? `, categories ${m.categories.join("/")}` : ""}; the server checked this order against it before creating the PayPal order.` : null,
    order.captureId ? `The buyer approved the payment personally in PayPal; the store captured it (capture ${order.captureId}${order.capturedAt ? ` at ${order.capturedAt}` : ""}). The agent cannot approve or capture payments.` : null,
  ].filter(Boolean) as string[];
  const evidence: Evidence[] = [{ evidence_type: "OTHER", notes: lines.join(" ") }];
  if (reason === "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED") {
    const seen = new Set<string>();
    // One line per ordered SKU (the agent may have searched several times and seen the same product again).
    const shown = searches
      .flatMap((s) => (Array.isArray(s.result) ? (s.result as any[]) : []))
      .filter((r) => order.items.some((i) => i.sku === r?.sku) && !seen.has(r.sku) && Boolean(seen.add(r.sku)));
    if (shown.length) {
      evidence.push({ evidence_type: "ITEM_DESCRIPTION", notes: `Product data the agent was shown before ordering: ${shown.slice(0, 3).map((r) => `${r.sku} "${r.description ?? r.name}" at ${r.price} USD`).join("; ")}.` });
    }
  }
  if (reason === "DUPLICATE_TRANSACTION") {
    evidence.push({ evidence_type: "OTHER", notes: `The agent journal shows ${createsInSession} successful create_order call(s) in this session; each PayPal order needs its own buyer approval.` });
  }
  return { evidence, summary: lines[0] };
}

export function assessStoreClaim(claim: ClaimRecord, order: OrderRecord, ctx: AgentContext, now: Date = new Date()): DeskCase {
  const status = claim.status === "OPEN" ? "WAITING_FOR_SELLER_RESPONSE" : "RESOLVED";
  const facts = factsForOrder(order, claim.reason, status, claim.createdAt, claim.note, now);
  const assessment = assessByRules(facts, { now });
  const ae = agentEvidence(order, ctx, claim.reason);
  if (claim.kind === "REFUND_REQUEST" && claim.status === "OPEN") {
    assessment.rationale.unshift("Refund request raised before any PayPal dispute: refunding now avoids a PayPal case and its fee.");
  }
  if (ae.summary) assessment.rationale.push("Agent receipt attached as evidence (see below).");
  return {
    caseId: claim.claimId,
    source: "store",
    kind: claim.kind,
    orderId: order.orderId,
    channel: order.channel,
    reason: claim.reason,
    reasonText: humanReason(claim.reason),
    amount: Number(order.total),
    currency: order.currency,
    status: claim.status,
    createdAt: claim.createdAt,
    note: claim.note,
    facts,
    assessment,
    agentEvidence: ae.evidence,
    agentSummary: ae.summary,
  };
}

/** PayPal-side dispute (Disputes v1 list item). Linked to a store order when the capture id matches. */
export function assessPayPalDispute(d: any, order: OrderRecord | undefined, ctx: AgentContext, now: Date = new Date()): DeskCase {
  const amount = Number(d?.dispute_amount?.value ?? 0);
  const currency = String(d?.dispute_amount?.currency_code ?? "USD");
  const reason = String(d?.reason ?? "OTHER");
  const base: CaseFacts = order
    ? factsForOrder(order, reason, String(d?.status ?? ""), String(d?.create_time ?? now.toISOString()), "", now)
    : {
        amount, currency, reason: reason as DisputeReason, stage: String(d?.dispute_life_cycle_stage ?? "INQUIRY"), channel: String(d?.dispute_channel ?? "INTERNAL"),
        status: String(d?.status ?? ""), daysToDue: null, digital: false, hasTracking: false, delivered: false, inTransit: false, returned: false,
        carrier: null, trackingNumbers: [], refundIds: [], addressConfirmed: false, protectionEligible: false, itemDescription: null,
        buyerMessages: 0, sellerReplied: false, orderId: null,
      };
  const facts: CaseFacts = { ...base, amount, currency, stage: String(d?.dispute_life_cycle_stage ?? base.stage), channel: String(d?.dispute_channel ?? base.channel), status: String(d?.status ?? "") };
  const assessment = assessByRules(facts, { now });
  const ae = order ? agentEvidence(order, ctx, reason) : { evidence: [], summary: null };
  return {
    caseId: String(d?.dispute_id ?? ""),
    source: "paypal",
    kind: "PAYPAL_DISPUTE",
    orderId: order?.orderId ?? null,
    channel: order?.channel ?? "unknown",
    reason,
    reasonText: humanReason(reason),
    amount,
    currency,
    status: String(d?.status ?? ""),
    createdAt: String(d?.create_time ?? ""),
    note: "",
    facts,
    assessment,
    agentEvidence: ae.evidence,
    agentSummary: ae.summary,
  };
}
