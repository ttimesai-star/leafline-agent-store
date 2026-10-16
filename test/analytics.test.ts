import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSources, dataDefinition, reportState } from "../web/analytics.js";
import { PRODUCTS } from "../src/catalog.ts";

const orders = [
  { orderId: "A1", createdAt: "2026-10-16T10:00:00Z", channel: "agent", session: "mcp_0123456789abcdef", mandateId: "md_x", items: [{ sku: "TEA-SENCHA-80", name: "Sencha", unitPrice: "11.50", quantity: 2 }], total: "23.00", status: "COMPLETED", captureId: "C1", refunds: [{ amount: "23.00" }] },
  { orderId: "H1", createdAt: "2026-10-15T10:00:00Z", channel: "human", session: null, mandateId: null, items: [{ sku: "MUG-STONE-350", name: "Mug", unitPrice: "18.00", quantity: 1 }], total: "18.00", status: "COMPLETED", captureId: "C2", refunds: [] },
  { orderId: "X1", createdAt: "2026-10-15T11:00:00Z", channel: "agent", session: "ag_abcdef01", mandateId: "md_y", items: [{ sku: "KETTLE-GOOSE-1L", name: "Kettle", unitPrice: "39.00", quantity: 1 }], total: "39.00", status: "CREATED", captureId: null, refunds: [] },
];
const journal = [
  { ts: "2026-10-16T09:59:00Z", session: "mcp_0123456789abcdef", tool: "create_order", ok: true, ms: 12 },
  { ts: "2026-10-16T09:59:30Z", session: "mcp_0123456789abcdef", tool: "create_order", ok: false, ms: 1 },
];
const cases = [{ caseId: "CLM-1", orderId: "A1", source: "store", reasonText: "not as described", status: "REFUNDED", amount: 23, assessment: { recommendation: "ACCEPT", winProbability: 0.2 } }];

test("sources: paid/net per order, channel and interface, revenue only for paid lines, refusals counted", () => {
  const s = buildSources({ orders, journal, cases, products: PRODUCTS });
  const a1 = s.orders.find((o: any) => o.order_id === "A1");
  assert.deepEqual([a1.channel, a1.interface, a1.paid, a1.paid_usd, a1.refunded_usd, a1.net_usd, a1.day], ["AI agent", "MCP server", "Paid", 23, 23, 0, "2026-10-16"]);
  assert.equal(s.orders.find((o: any) => o.order_id === "X1").paid_usd, 0, "an unapproved order is not revenue");
  assert.equal(s.orders.find((o: any) => o.order_id === "X1").interface, "WebMCP (in page)");
  assert.deepEqual(s.lines.map((l: any) => [l.category, l.revenue_usd]), [["tea", 23], ["teaware", 18], ["teaware", 0]]);
  assert.deepEqual(s.calls.map((c: any) => [c.outcome, c.allowed, c.refused]), [["Allowed", 1, 0], ["Refused", 0, 1]]);
  assert.deepEqual([s.cases[0].advice, s.cases[0].win_pct], ["ACCEPT", 20]);
});

test("every field the pre-built report uses exists in the data definition", () => {
  const def = dataDefinition(buildSources({ orders, journal, cases, products: PRODUCTS }));
  const known = new Set(def.sources.flatMap((src: any) => src.fields.map((f: any) => `${src.id}.${f.id}`)));
  for (const src of def.sources) for (const row of src.data) for (const k of Object.keys(row)) assert.ok(known.has(`${src.id}.${k}`), `field ${src.id}.${k} has a definition`);
  const page = reportState().pages[0];
  const refs = JSON.stringify(page.widgets).match(/"id":"[a-z]+\.[a-z_]+"/g)!.map((x) => x.slice(6, -1));
  assert.ok(refs.length > 10);
  for (const r of refs) assert.ok(known.has(r), `widget field ${r}`);
  assert.deepEqual(Object.keys(page.widgets).sort(), Object.keys(page.widgetLayout).sort(), "every widget has a layout");
  for (const l of Object.values(page.widgetLayout) as any[]) assert.ok(l.xTrack + l.xSpan <= 24, "fits 24 tracks");
});
