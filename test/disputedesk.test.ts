import { test } from "node:test";
import assert from "node:assert/strict";
import { round2, assessByRules } from "../src/disputedesk/rules.ts";
import { agentEvidence, factsForOrder } from "../src/disputedesk/desk.ts";
import type { OrderRecord } from "../src/orders.ts";

const order: OrderRecord = {
  orderId: "ORDER1",
  createdAt: "2026-10-16T09:00:00.000Z",
  channel: "agent",
  session: "ag_test0001",
  mandateId: null,
  items: [
    { sku: "TEA-SENCHA-80", name: "Organic Sencha, 80 g", quantity: 1, unitPrice: "11.50" } as any,
    { sku: "MUG-STONE-350", name: "Stoneware Mug 350 ml", quantity: 1, unitPrice: "18.00" } as any,
  ],
  total: "29.50",
  currency: "USD",
  status: "COMPLETED",
  captureId: "CAP1",
  capturedAt: "2026-10-16T09:01:00.000Z",
  payerEmail: null,
  refunds: [],
};

test("round2 is sign-symmetric and absorbs binary noise", () => {
  assert.equal(round2(24.175), 24.18);
  assert.equal(round2(-24.175), -24.18);
  assert.equal(round2(-29.5), -29.5);
  assert.equal(round2(0), 0);
  assert.equal(round2(1.005), 1.01);
});

test("rationale text and expected values use the same rounding", () => {
  const now = new Date("2026-10-16T10:00:00.000Z");
  const facts = factsForOrder(order, "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", "WAITING_FOR_SELLER_RESPONSE", "2026-10-16T09:30:00.000Z", "stale", now);
  const a = assessByRules(facts, { now });
  const line = a.rationale.find((r) => /^(Fighting|Accepting):/.test(r));
  assert.ok(line, "a fight/accept rationale line exists");
  assert.ok(line!.includes(`${Math.abs(a.expected.fight).toFixed(2)} USD`), `${line} vs ${a.expected.fight}`);
});

test("item-description evidence lists each ordered SKU once", () => {
  const hit = (sku: string, price: string) => ({ sku, name: sku, description: "product text", price });
  const calls = [
    { ts: "t1", session: "ag_test0001", tool: "search_products", args: {}, ok: true, summary: "", result: [hit("TEA-SENCHA-80", "11.50"), hit("MUG-STONE-350", "18.00")] },
    { ts: "t2", session: "ag_test0001", tool: "search_products", args: {}, ok: true, summary: "", result: [hit("MUG-STONE-350", "18.00"), hit("KETTLE-GOOSE-1L", "39.00")] },
    { ts: "t3", session: "ag_test0001", tool: "create_order", args: {}, ok: true, summary: "", orderId: "ORDER1" },
  ];
  const { evidence } = agentEvidence(order, { calls, mandate: null }, "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED");
  const item = evidence.find((e) => e.evidence_type === "ITEM_DESCRIPTION");
  assert.ok(item);
  assert.equal(item!.notes!.match(/MUG-STONE-350/g)?.length, 1);
  assert.match(item!.notes!, /TEA-SENCHA-80/);
  assert.doesNotMatch(item!.notes!, /KETTLE/, "products the buyer did not order are not cited");
});
