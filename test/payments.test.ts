// The server wired the way src/server.ts main() wires it: our Orders v2 client for create/capture, the PayPal
// Agent Toolkit for status, disputes and refunds. PayPal itself is faked at the HTTP-client / Toolkit-run level.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHandler } from "../src/server.ts";
import { AgentJournal } from "../src/journal.ts";
import { OrderStore } from "../src/orders.ts";
import { MandateStore } from "../src/mandates.ts";
import { PayPalClient } from "../src/paypal.ts";
import { ToolkitPayments, type ToolkitApi } from "../src/toolkit.ts";
import { composePayments } from "../src/payments.ts";

const world = new Map<string, any>();
const kitRuns: Array<{ method: string; arg: any; requestId?: string }> = [];
let seq = 0;

// Fake PayPal REST for our own client (create + capture only).
const fetchImpl = (async (url: string, init: any) => {
  const u = new URL(url);
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  if (u.pathname === "/v1/oauth2/token") return json({ access_token: "TOKEN-A", expires_in: 3600 });
  if (u.pathname === "/v2/checkout/orders" && init.method === "POST") {
    const body = JSON.parse(init.body);
    const id = `KITORDER${String(++seq).padStart(4, "0")}`;
    const o = { id, status: "PAYER_ACTION_REQUIRED", purchase_units: [{ ...body.purchase_units[0] }], links: [{ rel: "payer-action", href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] };
    world.set(id, o);
    return json(o, 201);
  }
  const cap = u.pathname.match(/^\/v2\/checkout\/orders\/([A-Z0-9]+)\/capture$/);
  if (cap) {
    const o = world.get(cap[1]);
    o.status = "COMPLETED";
    o.purchase_units[0].payments = { captures: [{ id: `CAP${cap[1].slice(-4)}XXXX`, status: "COMPLETED" }] };
    return json(o, 201);
  }
  return json({ name: "NOT_FOUND" }, 404);
}) as typeof fetch;

const makeApi = (token: string, requestId?: string): ToolkitApi => ({
  async run(method, arg: any) {
    kitRuns.push({ method, arg, requestId });
    assert.equal(token, "TOKEN-A", "the Toolkit gets our refreshed OAuth token");
    if (method === "get_order") return JSON.stringify(world.get(arg.id) ?? { ok: false, status: 404, code: "PAYPAL_API_HTTP_ERROR", message: "RESOURCE_NOT_FOUND" });
    if (method === "create_refund") return JSON.stringify({ id: "KITREFUND01", status: "COMPLETED", amount: { value: "11.50" } });
    if (method === "list_disputes") return JSON.stringify({ items: [{ dispute_id: "PP-D-777777", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", status: "WAITING_FOR_SELLER_RESPONSE", dispute_amount: { value: "11.50", currency_code: "USD" } }] });
    if (method === "get_dispute") return JSON.stringify({ dispute_id: arg.dispute_id, reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", status: "WAITING_FOR_SELLER_RESPONSE", dispute_amount: { value: "11.50", currency_code: "USD" } });
    if (method === "accept_dispute_claim") return JSON.stringify({ links: [{ rel: "self" }] });
    return JSON.stringify({ error: { message: `unexpected ${method}` } });
  },
});

let server: Server;
let base = "";
before(async () => {
  const own = new PayPalClient({ clientId: "CID", secret: "SECRET", fetchImpl });
  const payments = composePayments(own, new ToolkitPayments({ token: () => own.getAccessToken(), makeApi }));
  server = createServer(createHandler({ payments, journal: new AgentJournal(), orders: new OrderStore(), mandates: new MandateStore(), baseUrl: "http://localhost:0", merchantKey: "MK" }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const post = (p: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("order -> capture on own client; status, claim refund and disputes through the Toolkit", async () => {
  const o = await (await post("/api/orders", { items: [{ sku: "TEA-SENCHA-80", quantity: 1 }], flow: "redirect" })).json();
  assert.match(o.orderId, /^KITORDER/);
  await fetch(`${base}/paypal/return?token=${o.orderId}`, { redirect: "manual" });
  const view = await (await fetch(`${base}/api/orders/${o.orderId}`)).json();
  assert.equal(view.status, "COMPLETED");
  assert.ok(kitRuns.some((r) => r.method === "get_order" && r.arg.id === o.orderId));

  const claim = await (await post(`/api/orders/${o.orderId}/claims`, { kind: "REFUND_REQUEST", reason: "OTHER", note: "x" })).json();
  assert.equal((await post(`/api/merchant/claims/${claim.claimId}/refund`, {})).status, 401, "merchant key required");
  const r = await (await post(`/api/merchant/claims/${claim.claimId}/refund`, {}, { "x-merchant-key": "MK" })).json();
  assert.equal(r.status, "REFUNDED");
  assert.equal(r.refundId, "KITREFUND01");
  const refundRun = kitRuns.find((x) => x.method === "create_refund")!;
  assert.equal(refundRun.requestId, `refund-${claim.claimId}`);
  assert.match(refundRun.arg.capture_id, /^CAP/);

  const cases = await (await fetch(`${base}/api/merchant/cases?refresh=1`)).json();
  assert.ok(cases.cases.some((c: any) => c.caseId === "PP-D-777777"));
  assert.equal(cases.paypalError, null);
});

test("accepting a PayPal dispute is merchant-only and goes through accept_dispute_claim", async () => {
  const agent = { "x-agent-tool": "open_dispute", "x-agent-session": "ag_kit00001", "x-merchant-key": "MK" };
  assert.equal((await post("/api/merchant/disputes/PP-D-777777/accept", {}, agent)).status, 403);
  assert.equal((await post("/api/merchant/disputes/PP-D-777777/accept", {})).status, 401);
  assert.equal((await post("/api/merchant/disputes/PP-D-77%2F../accept", {}, { "x-merchant-key": "MK" })).status, 404);
  const ok = await post("/api/merchant/disputes/PP-D-777777/accept", { note: "sorry" }, { "x-merchant-key": "MK" });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).accepted, true);
  assert.deepEqual(kitRuns.filter((x) => x.method === "accept_dispute_claim").map((x) => x.arg), [{ dispute_id: "PP-D-777777", note: "sorry" }]);
});

test("health and merchant Toolkit log show the Toolkit and its calls, no payloads", async () => {
  const h = await (await fetch(`${base}/api/health`)).json();
  assert.equal(h.toolkit, "1.11.0");
  const t = await (await fetch(`${base}/api/merchant/toolkit`)).json();
  assert.equal(t.toolkit.package, "@paypal/agent-toolkit");
  assert.equal(t.toolkit.tools.length, 6);
  const tools = new Set(t.calls.map((c: any) => c.tool));
  for (const k of ["get_order", "create_refund", "list_disputes", "accept_dispute_claim"]) assert.ok(tools.has(k), k);
  assert.ok(!JSON.stringify(t).includes("CAP"), "no capture ids or arguments in the log");
});
