import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHandler } from "../src/server.ts";
import { AgentJournal } from "../src/journal.ts";
import { PayPalError } from "../src/paypal.ts";
import { buildStoreTools } from "../web/webmcp.js";

const calls: string[] = [];
const fakePayments = {
  async createOrder(input: any) {
    calls.push(`create ${input.total} ${input.customId}`);
    return {
      id: "TESTORDER123",
      status: "PAYER_ACTION_REQUIRED",
      purchase_units: [{ amount: { value: input.total, currency_code: "USD" } }],
      links: [{ rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=TESTORDER123" }],
    };
  },
  async getOrder(id: string) {
    if (id === "MISSING0001") throw new PayPalError("GET: HTTP 404 RESOURCE_NOT_FOUND", 404, "dbg", "INVALID_RESOURCE_ID");
    return { id, status: "APPROVED", purchase_units: [{ amount: { value: "11.50", currency_code: "USD" } }] };
  },
  async captureOrder(id: string) {
    calls.push(`capture ${id}`);
    return {
      id,
      status: "COMPLETED",
      purchase_units: [{ amount: { value: "11.50", currency_code: "USD" }, payments: { captures: [{ id: "CAP1", status: "COMPLETED" }] } }],
    };
  },
};

let server: Server;
let base = "";
const journal = new AgentJournal();
before(async () => {
  server = createServer(createHandler({ payments: fakePayments as any, journal, baseUrl: "http://localhost:0" }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

test("serves the storefront and scripts, nothing else", async () => {
  const r = await fetch(base + "/");
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Agent-ready store/);
  assert.equal((await fetch(base + "/webmcp.js")).status, 200);
  assert.equal((await fetch(base + "/../src/paypal.ts")).status, 404);
});

test("human order: server-side price, approve link, capture on return", async () => {
  const r = await fetch(base + "/api/orders", { method: "POST", body: JSON.stringify({ items: [{ sku: "TEA-SENCHA-80", quantity: 1, price: "0.01" }] }) });
  const d = await r.json();
  assert.equal(r.status, 201);
  assert.equal(d.total, "11.50 USD");
  assert.match(d.approveUrl, /^https:\/\/www\.sandbox\.paypal\.com\//);
  const ret = await fetch(base + "/paypal/return?token=TESTORDER123", { redirect: "manual" });
  assert.equal(ret.status, 302);
  assert.match(ret.headers.get("location")!, /status=COMPLETED/);
  assert.ok(calls.includes("capture TESTORDER123"));
});

test("bad input and provider errors map to safe HTTP errors", async () => {
  assert.equal((await fetch(base + "/api/orders", { method: "POST", body: "{bad" })).status, 400);
  assert.equal((await fetch(base + "/api/orders", { method: "POST", body: JSON.stringify({ items: [{ sku: "NOPE", quantity: 1 }] }) })).status, 400);
  assert.equal((await fetch(base + "/api/orders", { method: "POST", body: "x".repeat(20000) })).status, 413);
  assert.equal((await fetch(base + "/api/orders/..%2F..%2Fv1")).status, 400);
  const nf = await fetch(base + "/api/orders/MISSING0001");
  assert.equal(nf.status, 422);
  assert.deepEqual(await nf.json(), { error: "payment provider error: INVALID_RESOURCE_ID", debugId: "dbg" });
});

test("agent flow through WebMCP tools is journaled per order; agents cannot capture", async () => {
  const tools = Object.fromEntries(buildStoreTools({ base, session: "ag_test0001" }).map((t: any) => [t.name, t]));
  const s = JSON.parse((await tools.search_products.execute({ query: "green tea", max_price: 12 })).content[0].text);
  assert.equal(s.items[0].sku, "TEA-SENCHA-80");
  const o = JSON.parse((await tools.create_order.execute({ items: [{ sku: s.items[0].sku, quantity: 1 }] })).content[0].text);
  assert.equal(o.orderId, "TESTORDER123");
  assert.ok(calls.some((c) => c.includes("agent:ag_test0001")));
  const st = JSON.parse((await tools.get_order_status.execute({ order_id: o.orderId })).content[0].text);
  assert.equal(st.status, "APPROVED");
  const bad = await tools.create_order.execute({ items: [{ sku: "NOPE", quantity: 1 }] });
  assert.equal(bad.isError, true);
  const cap = await fetch(base + "/api/orders/TESTORDER123/capture", { method: "POST", headers: { "x-agent-tool": "x", "x-agent-session": "ag_test0001" } });
  assert.equal(cap.status, 403);
  const receipt = await (await fetch(base + "/api/orders/TESTORDER123/agent-log")).json();
  assert.equal(receipt.session, "ag_test0001");
  assert.deepEqual(receipt.calls.map((c: any) => c.tool), ["search_products", "create_order", "get_order_status", "create_order", "x"]);
  assert.equal(receipt.calls[3].ok, false, "failed attempts stay in the agent trail");
  assert.equal(receipt.calls[4].summary, "capture refused for agents");
});
