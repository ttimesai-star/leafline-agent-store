import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrderStore } from "../src/orders.ts";

const base = { createdAt: "2026-10-16T10:00:00Z", channel: "agent" as const, session: "ag_aaaaaa", mandateId: null, items: [], total: "11.50", currency: "USD", status: "PAYER_ACTION_REQUIRED" };

test("orders and claims persist to a JSON snapshot", () => {
  const file = join(mkdtempSync(join(tmpdir(), "pas-")), "d", "orders.json");
  const s = new OrderStore(file);
  s.addOrder({ ...base, orderId: "ORDER0001" });
  assert.throws(() => s.openClaim({ orderId: "ORDER0001", kind: "REFUND_REQUEST", by: "agent", session: null }), /only paid/);
  s.updateOrder("ORDER0001", { status: "COMPLETED", captureId: "CAP1" });
  const c = s.openClaim({ orderId: "ORDER0001", kind: "DISPUTE", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", note: "never arrived\u0007", by: "agent", session: "ag_aaaaaa" });
  assert.match(c.claimId, /^CLM-[0-9A-F]{8}$/);
  assert.equal(c.note, "never arrived");
  assert.throws(() => s.openClaim({ orderId: "ORDER0001", kind: "REFUND_REQUEST", by: "buyer", session: null }), /already has an open claim/);
  const again = new OrderStore(file);
  assert.equal(again.getOrder("ORDER0001")!.status, "COMPLETED");
  assert.equal(again.listClaims().length, 1);
  again.resolveClaim(c.claimId, { status: "REFUNDED", resolution: "refunded", refundId: "R1" });
  assert.throws(() => again.resolveClaim(c.claimId, { status: "DECLINED", resolution: "x" }), /already REFUNDED/);
});

test("claim validation", () => {
  const s = new OrderStore();
  s.addOrder({ ...base, orderId: "ORDER0002", status: "COMPLETED", captureId: "CAP2" });
  assert.throws(() => s.openClaim({ orderId: "NOPE", kind: "DISPUTE", by: "buyer", session: null }), /not found/);
  assert.throws(() => s.openClaim({ orderId: "ORDER0002", kind: "CHARGEBACK", by: "buyer", session: null }), /kind must be/);
  assert.throws(() => s.openClaim({ orderId: "ORDER0002", kind: "DISPUTE", reason: "FRAUD", by: "buyer", session: null }), /reason must be/);
  s.addRefund("ORDER0002", { refundId: "R9", amount: "11.50", status: "COMPLETED", at: "x" });
  assert.throws(() => s.openClaim({ orderId: "ORDER0002", kind: "DISPUTE", by: "buyer", session: null }), /already refunded/);
});
