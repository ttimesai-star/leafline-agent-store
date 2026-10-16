// Spending mandates: the buyer (a human, on the store page) delegates shopping to an AI agent with a hard
// budget, an optional per-order cap, an optional category allow-list and an expiry. The server checks every
// agent order against the mandate BEFORE the PayPal order is created, so an agent cannot overspend even if
// it ignores its instructions. The buyer still approves each payment in PayPal; the mandate only bounds
// what the agent may put in front of the buyer.
import { randomBytes } from "node:crypto";
import { fromCents } from "./catalog.ts";

export const MAX_BUDGET_CENTS = 200_00;
export const DEFAULT_TTL_MIN = 60;
const MAX_MANDATES = 1000;
const ID_RE = /^md_[a-f0-9]{16}$/;
const CATEGORIES = ["tea", "coffee", "teaware", "gift"] as const;

export type MandateErrorCode = "NOT_FOUND" | "EXPIRED" | "REVOKED" | "OVER_BUDGET" | "OVER_PER_ORDER" | "CATEGORY_NOT_ALLOWED" | "INVALID";

export class MandateError extends Error {
  code: MandateErrorCode;
  constructor(code: MandateErrorCode, message: string) {
    super(message);
    this.name = "MandateError";
    this.code = code;
  }
}

export interface Mandate {
  id: string;
  budgetCents: number;
  perOrderCents: number | null;
  categories: string[] | null;
  note: string;
  createdAt: string;
  expiresAt: string;
  revoked: boolean;
  /** orderId -> cents committed to that order (pending or paid). */
  orders: Map<string, number>;
  /** cents held by in-flight create_order calls (between check and PayPal response). */
  heldCents: number;
}

export interface MandateView {
  mandateId: string;
  status: "ACTIVE" | "EXPIRED" | "REVOKED";
  budget: string;
  spent: string;
  remaining: string;
  perOrderMax: string | null;
  categories: string[] | null;
  note: string;
  expiresAt: string;
  orders: string[];
  currency: "USD";
}

export function validMandateId(s: unknown): s is string {
  return typeof s === "string" && ID_RE.test(s);
}

function dollarsToCents(v: unknown, field: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new MandateError("INVALID", `${field} must be a positive number of USD`);
  return Math.round(n * 100);
}

export class MandateStore {
  private items = new Map<string, Mandate>();

  create(input: { budget?: unknown; per_order_max?: unknown; categories?: unknown; ttl_minutes?: unknown; note?: unknown }, now: Date = new Date()): MandateView {
    const budgetCents = dollarsToCents(input?.budget, "budget");
    if (budgetCents > MAX_BUDGET_CENTS) throw new MandateError("INVALID", `budget must be at most ${fromCents(MAX_BUDGET_CENTS)} USD in this sandbox demo`);
    let perOrderCents: number | null = null;
    if (input.per_order_max !== undefined && input.per_order_max !== null && input.per_order_max !== "") {
      perOrderCents = dollarsToCents(input.per_order_max, "per_order_max");
      if (perOrderCents > budgetCents) throw new MandateError("INVALID", "per_order_max cannot exceed budget");
    }
    let categories: string[] | null = null;
    if (Array.isArray(input.categories) && input.categories.length) {
      categories = [...new Set(input.categories.map(String))];
      const bad = categories.find((c) => !(CATEGORIES as readonly string[]).includes(c));
      if (bad) throw new MandateError("INVALID", `unknown category: ${bad.slice(0, 20)} (allowed: ${CATEGORIES.join(", ")})`);
    }
    const ttl = input.ttl_minutes === undefined ? DEFAULT_TTL_MIN : Number(input.ttl_minutes);
    if (!Number.isInteger(ttl) || ttl < 5 || ttl > 24 * 60) throw new MandateError("INVALID", "ttl_minutes must be an integer 5..1440");
    const note = String(input.note ?? "").replace(/[\u0000-\u001f]/g, " ").slice(0, 160);
    if (this.items.size >= MAX_MANDATES) this.items.delete(this.items.keys().next().value!);
    const m: Mandate = {
      id: "md_" + randomBytes(8).toString("hex"),
      budgetCents,
      perOrderCents,
      categories,
      note,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttl * 60_000).toISOString(),
      revoked: false,
      orders: new Map(),
      heldCents: 0,
    };
    this.items.set(m.id, m);
    return this.view(m.id, now)!;
  }

  private spent(m: Mandate): number {
    let s = m.heldCents;
    for (const c of m.orders.values()) s += c;
    return s;
  }

  private status(m: Mandate, now: Date): MandateView["status"] {
    if (m.revoked) return "REVOKED";
    if (Date.parse(m.expiresAt) <= now.getTime()) return "EXPIRED";
    return "ACTIVE";
  }

  view(id: string, now: Date = new Date()): MandateView | null {
    const m = validMandateId(id) ? this.items.get(id) : undefined;
    if (!m) return null;
    const spent = this.spent(m);
    return {
      mandateId: m.id,
      status: this.status(m, now),
      budget: fromCents(m.budgetCents),
      spent: fromCents(spent),
      remaining: fromCents(Math.max(0, m.budgetCents - spent)),
      perOrderMax: m.perOrderCents === null ? null : fromCents(m.perOrderCents),
      categories: m.categories,
      note: m.note,
      expiresAt: m.expiresAt,
      orders: [...m.orders.keys()],
      currency: "USD",
    };
  }

  /**
   * Check an order against the mandate and hold the amount. The caller must call commit(orderId) once
   * PayPal created the order, or release() if it failed. Synchronous, so two parallel agent calls
   * cannot both pass the same remaining budget.
   */
  reserve(id: string, cents: number, categories: string[], now: Date = new Date()): { commit(orderId: string): void; release(): void } {
    const m = validMandateId(id) ? this.items.get(id) : undefined;
    if (!m) throw new MandateError("NOT_FOUND", "mandate not found: ask the buyer to delegate a budget on the store page");
    const st = this.status(m, now);
    if (st === "REVOKED") throw new MandateError("REVOKED", "the buyer revoked this mandate");
    if (st === "EXPIRED") throw new MandateError("EXPIRED", "this mandate has expired");
    if (m.categories) {
      const bad = categories.find((c) => !m.categories!.includes(c));
      if (bad) throw new MandateError("CATEGORY_NOT_ALLOWED", `category '${bad}' is not allowed by the mandate (allowed: ${m.categories.join(", ")})`);
    }
    if (m.perOrderCents !== null && cents > m.perOrderCents) {
      throw new MandateError("OVER_PER_ORDER", `order total ${fromCents(cents)} USD exceeds the per-order limit ${fromCents(m.perOrderCents)} USD`);
    }
    const remaining = m.budgetCents - this.spent(m);
    if (cents > remaining) throw new MandateError("OVER_BUDGET", `order total ${fromCents(cents)} USD exceeds the remaining budget ${fromCents(Math.max(0, remaining))} USD`);
    m.heldCents += cents;
    let done = false;
    return {
      commit(orderId: string) {
        if (done) return;
        done = true;
        m.heldCents -= cents;
        m.orders.set(orderId, cents);
      },
      release() {
        if (done) return;
        done = true;
        m.heldCents -= cents;
      },
    };
  }

  /** Give the budget back for an order the buyer cancelled (never for a paid order: the caller checks). */
  releaseOrder(orderId: string): boolean {
    for (const m of this.items.values()) if (m.orders.delete(orderId)) return true;
    return false;
  }

  revoke(id: string): boolean {
    const m = validMandateId(id) ? this.items.get(id) : undefined;
    if (!m) return false;
    m.revoked = true;
    return true;
  }
}
