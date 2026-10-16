// Local record of every order the store created, and of every post-purchase claim (refund request or
// dispute) raised by a buyer or by the buyer's agent. PayPal stays the source of truth for payment state;
// this is the merchant's view that ties PayPal ids to the channel (human / agent), the agent session,
// the mandate and the claims. In memory, optionally mirrored to a JSON file (demo persistence).
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { PricedLine } from "./catalog.ts";

export interface RefundRecord {
  refundId: string;
  amount: string;
  status: string;
  at: string;
  claimId?: string;
}

export interface OrderRecord {
  orderId: string;
  createdAt: string;
  channel: "human" | "agent";
  session: string | null;
  mandateId: string | null;
  items: PricedLine[];
  total: string;
  currency: string;
  status: string;
  captureId: string | null;
  capturedAt: string | null;
  payerEmail: string | null;
  refunds: RefundRecord[];
}

export type ClaimKind = "REFUND_REQUEST" | "DISPUTE";
export const CLAIM_REASONS = ["MERCHANDISE_OR_SERVICE_NOT_RECEIVED", "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", "DUPLICATE_TRANSACTION", "INCORRECT_AMOUNT", "OTHER"] as const;
export type ClaimReason = (typeof CLAIM_REASONS)[number];

export interface ClaimRecord {
  claimId: string;
  orderId: string;
  kind: ClaimKind;
  reason: ClaimReason;
  note: string;
  by: "agent" | "buyer";
  session: string | null;
  createdAt: string;
  status: "OPEN" | "REFUNDED" | "DECLINED";
  resolvedAt: string | null;
  resolution: string | null;
  refundId: string | null;
}

const MAX_ORDERS = 5000;

export class OrderStore {
  private orders = new Map<string, OrderRecord>();
  private claims = new Map<string, ClaimRecord>();
  private file: string | undefined;

  constructor(file?: string) {
    this.file = file;
    if (file && existsSync(file)) {
      try {
        const d = JSON.parse(readFileSync(file, "utf8"));
        for (const o of d.orders ?? []) this.orders.set(o.orderId, o);
        for (const c of d.claims ?? []) this.claims.set(c.claimId, c);
      } catch {
        // A corrupt demo snapshot must not stop the store; start empty.
      }
    }
  }

  private save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify({ orders: [...this.orders.values()], claims: [...this.claims.values()] }));
    renameSync(tmp, this.file);
  }

  addOrder(o: Omit<OrderRecord, "refunds" | "captureId" | "capturedAt" | "payerEmail"> & Partial<OrderRecord>): OrderRecord {
    if (this.orders.size >= MAX_ORDERS) this.orders.delete(this.orders.keys().next().value!);
    const rec: OrderRecord = { captureId: null, capturedAt: null, payerEmail: null, refunds: [], ...o };
    this.orders.set(rec.orderId, rec);
    this.save();
    return rec;
  }

  getOrder(id: string): OrderRecord | undefined {
    return this.orders.get(id);
  }

  updateOrder(id: string, patch: Partial<OrderRecord>): OrderRecord | undefined {
    const o = this.orders.get(id);
    if (!o) return undefined;
    Object.assign(o, patch, { orderId: o.orderId });
    this.save();
    return o;
  }

  addRefund(id: string, r: RefundRecord): void {
    const o = this.orders.get(id);
    if (!o) return;
    o.refunds.push(r);
    this.save();
  }

  listOrders(): OrderRecord[] {
    return [...this.orders.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Validates and opens a claim. One open claim per order. */
  openClaim(input: { orderId: string; kind: unknown; reason?: unknown; note?: unknown; by: "agent" | "buyer"; session: string | null }, now: Date = new Date()): ClaimRecord {
    const o = this.orders.get(input.orderId);
    if (!o) throw new Error("order not found in this store");
    if (input.kind !== "REFUND_REQUEST" && input.kind !== "DISPUTE") throw new Error("kind must be REFUND_REQUEST or DISPUTE");
    if (o.status !== "COMPLETED" || !o.captureId) throw new Error("only paid (COMPLETED) orders can be refunded or disputed");
    const reason = (input.reason ?? (input.kind === "DISPUTE" ? "MERCHANDISE_OR_SERVICE_NOT_RECEIVED" : "OTHER")) as ClaimReason;
    if (!(CLAIM_REASONS as readonly string[]).includes(reason)) throw new Error(`reason must be one of ${CLAIM_REASONS.join(", ")}`);
    if ([...this.claims.values()].some((c) => c.orderId === o.orderId && c.status === "OPEN")) throw new Error("this order already has an open claim");
    if (o.refunds.length) throw new Error("this order was already refunded");
    const note = String(input.note ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 500);
    const c: ClaimRecord = {
      claimId: "CLM-" + randomBytes(4).toString("hex").toUpperCase(),
      orderId: o.orderId,
      kind: input.kind,
      reason,
      note,
      by: input.by,
      session: input.session,
      createdAt: now.toISOString(),
      status: "OPEN",
      resolvedAt: null,
      resolution: null,
      refundId: null,
    };
    this.claims.set(c.claimId, c);
    this.save();
    return c;
  }

  getClaim(id: string): ClaimRecord | undefined {
    return this.claims.get(id);
  }

  resolveClaim(id: string, patch: Pick<ClaimRecord, "status" | "resolution"> & { refundId?: string | null }, now: Date = new Date()): ClaimRecord {
    const c = this.claims.get(id);
    if (!c) throw new Error("claim not found");
    if (c.status !== "OPEN") throw new Error(`claim is already ${c.status}`);
    c.status = patch.status;
    c.resolution = patch.resolution;
    c.refundId = patch.refundId ?? null;
    c.resolvedAt = now.toISOString();
    this.save();
    return c;
  }

  listClaims(): ClaimRecord[] {
    return [...this.claims.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  claimsFor(orderId: string): ClaimRecord[] {
    return this.listClaims().filter((c) => c.orderId === orderId);
  }
}
