import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanDemoData, readDemoData, writeDemoData, seedIfEmpty } from "../src/demo_data.ts";

const order = (orderId: string, status: string, session: string | null, captureId: string | null = null) =>
  ({ orderId, status, session, captureId, createdAt: "2026-10-16T10:00:00Z", channel: session ? "agent" : "human", mandateId: null, items: [], total: "1.00", currency: "USD", capturedAt: null, payerEmail: null, refunds: [] }) as any;
const claim = (claimId: string, orderId: string) => ({ claimId, orderId, kind: "DISPUTE", reason: "OTHER", note: "", by: "buyer", session: null, createdAt: "x", status: "OPEN", resolvedAt: null, resolution: null, refundId: null }) as any;
const entry = (session: string, tool: string, orderId?: string) => ({ ts: "x", session, tool, args: {}, ok: true, summary: "", ...(orderId ? { orderId } : {}) }) as any;

const sample = () => ({
  orders: [order("PAID1", "COMPLETED", "ag_s1", "CAP1"), order("ABAND", "CREATED", "ag_s2"), order("CANC", "CANCELLED", null), order("HUMANPAID", "COMPLETED", null, "CAP2")],
  claims: [claim("CLM-1", "PAID1"), claim("CLM-2", "ABAND")],
  journal: [entry("ag_s1", "search_products"), entry("ag_s1", "create_order", "PAID1"), entry("ag_s1", "create_order"), entry("ag_s2", "create_order", "ABAND"), entry("ag_s3", "get_budget")],
});

test("paid mode keeps paid orders, their claims and the whole agent trail; drops abandoned checkouts", () => {
  const r = cleanDemoData(sample(), "paid");
  assert.deepEqual(r.orders.map((o) => o.orderId), ["PAID1", "HUMANPAID"]);
  assert.deepEqual(r.claims.map((c) => c.claimId), ["CLM-1"]);
  assert.equal(r.journal.length, 3, "session ag_s1 kept whole, including the refused call");
  assert.ok(r.journal.every((e) => e.session === "ag_s1"));
  assert.deepEqual(r.dropped, { orders: 2, claims: 1, journal: 2 });
});

test("wipe mode empties everything", () => {
  const r = cleanDemoData(sample(), "wipe");
  assert.equal(r.orders.length + r.claims.length + r.journal.length, 0);
  assert.deepEqual(r.dropped, { orders: 4, claims: 2, journal: 5 });
});

test("write/read round trip and seeding only into an empty data dir", () => {
  const seed = mkdtempSync(join(tmpdir(), "seed-"));
  const data = mkdtempSync(join(tmpdir(), "data-"));
  writeDemoData(seed, cleanDemoData(sample(), "paid"));
  const back = readDemoData(seed);
  assert.equal(back.orders.length, 2);
  assert.equal(back.journal.length, 3);
  assert.equal(seedIfEmpty(data, undefined), 0, "no seed configured");
  assert.equal(seedIfEmpty(data, seed), 2);
  assert.ok(existsSync(join(data, "agent_journal.jsonl")));
  writeFileSync(join(data, "orders.json"), JSON.stringify({ orders: [], claims: [] }));
  assert.equal(seedIfEmpty(data, seed), 0, "an existing order book is never overwritten");
  assert.equal(JSON.parse(readFileSync(join(data, "orders.json"), "utf8")).orders.length, 0);
});
