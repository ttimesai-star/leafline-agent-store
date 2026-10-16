import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHandler, RateLimiter, maskEmail, maskKeys } from "../src/server.ts";
import { AgentJournal } from "../src/journal.ts";
import { OrderStore } from "../src/orders.ts";
import { MandateStore } from "../src/mandates.ts";
import { PayPalError } from "../src/paypal.ts";
import { buildStoreTools } from "../web/webmcp.js";

// In-memory fake of the PayPal sandbox: orders move CREATED -> (approved by test) -> COMPLETED on capture.
const calls: string[] = [];
const pp = new Map<string, any>();
let seq = 0;
const fakePayments = {
  clientId: "PUBLIC-CLIENT-ID",
  async createOrder(input: any) {
    const id = `TESTORDER${String(++seq).padStart(3, "0")}`;
    calls.push(`create ${id} ${input.total} ${input.customId} ${input.returnUrl ? "redirect" : "sdk"}`);
    const o = {
      id,
      status: input.returnUrl ? "PAYER_ACTION_REQUIRED" : "CREATED",
      purchase_units: [{ reference_id: input.referenceId, custom_id: input.customId, amount: { value: input.total, currency_code: "USD" }, items: input.items.map((i: any) => ({ sku: i.sku, name: i.name, quantity: String(i.quantity), unit_amount: { value: i.unitPrice } })) }],
      links: [{ rel: input.returnUrl ? "payer-action" : "approve", href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }],
    };
    pp.set(id, o);
    return o;
  },
  async getOrder(id: string) {
    const o = pp.get(id);
    if (!o) throw new PayPalError("GET: HTTP 404 RESOURCE_NOT_FOUND", 404, "dbg", "INVALID_RESOURCE_ID");
    return o;
  },
  async captureOrder(id: string) {
    calls.push(`capture ${id}`);
    const o = pp.get(id);
    if (!o) throw new PayPalError("x", 404, "dbg", "INVALID_RESOURCE_ID");
    o.status = "COMPLETED";
    o.payer = { email_address: "buyer@example.com" };
    o.purchase_units[0].payments = { captures: [{ id: `CAP${id.slice(-3)}XXXXX`, status: "COMPLETED", create_time: "2026-10-16T10:00:00Z" }] };
    return o;
  },
  async refundCapture(captureId: string, _opts: any, requestId?: string) {
    calls.push(`refund ${captureId} ${requestId}`);
    return { id: "REFUND00001", status: "COMPLETED", amount: { value: "11.50" } };
  },
  async listDisputes() {
    return { items: [{ dispute_id: "PP-D-12345", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", status: "WAITING_FOR_SELLER_RESPONSE", dispute_amount: { value: "11.50", currency_code: "USD" }, create_time: "2026-10-16T10:00:00Z" }] };
  },
  async getDispute(id: string) {
    return { ...(await this.listDisputes()).items[0], dispute_id: id, disputed_transactions: [{ seller_transaction_id: "CAP001XXXXX" }] };
  },
};

let server: Server;
let base = "";
const journal = new AgentJournal();
const orders = new OrderStore();
const mandates = new MandateStore();
before(async () => {
  server = createServer(createHandler({ payments: fakePayments as any, journal, orders, mandates, baseUrl: "http://localhost:0", version: "test" }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const post = (p: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const agentHeaders = (session: string, mandate?: string) => ({ "x-agent-tool": "t", "x-agent-session": session, ...(mandate ? { "x-agent-mandate": mandate } : {}) });

test("serves pages with COOP for the PayPal popup, nothing outside web/", async () => {
  for (const p of ["/", "/order", "/merchant", "/webmcp.js", "/agent.js", "/store.js", "/style.css", "/vendor/mcp-b-global.iife.js"]) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
  }
  const home = await fetch(base + "/");
  assert.equal(home.headers.get("cross-origin-opener-policy"), "same-origin-allow-popups");
  assert.match(await home.text(), /Leafline/);
  assert.equal((await fetch(base + "/../src/paypal.ts")).status, 404);
  assert.equal((await fetch(base + "/%2e%2e/src/paypal.ts")).status, 404);
  assert.equal((await fetch(base + "/nope.js")).status, 404);
  const cfg = await (await fetch(base + "/api/config")).json();
  assert.equal(cfg.clientId, "PUBLIC-CLIENT-ID");
  assert.equal(cfg.sdkUrl, "https://www.sandbox.paypal.com/web-sdk/v6/core");
  assert.ok(!JSON.stringify(cfg).toLowerCase().includes("secret"));
});

test("human checkout via JS SDK: server-side price, no redirect, capture records the order", async () => {
  const r = await post("/api/orders", { items: [{ sku: "TEA-SENCHA-80", quantity: 1, price: "0.01" }] });
  const d = await r.json();
  assert.equal(r.status, 201);
  assert.equal(d.total, "11.50 USD");
  assert.ok(calls.includes(`create ${d.orderId} 11.50 human sdk`));
  const cap = await (await post(`/api/orders/${d.orderId}/capture`, {})).json();
  assert.equal(cap.status, "COMPLETED");
  const view = await (await fetch(`${base}/api/orders/${d.orderId}`)).json();
  assert.equal(view.channel, "human");
  assert.equal(view.status, "COMPLETED");
  assert.equal(orders.getOrder(d.orderId)!.payerEmail, "b***@example.com");
});

test("redirect flow: return URL captures and lands on the order page; cancel releases", async () => {
  const d = await (await post("/api/orders", { items: [{ sku: "MUG-STONE-350", quantity: 1 }], flow: "redirect" })).json();
  assert.match(d.approveUrl, /^https:\/\/www\.sandbox\.paypal\.com\//);
  const ret = await fetch(`${base}/paypal/return?token=${d.orderId}`, { redirect: "manual" });
  assert.equal(ret.status, 302);
  assert.equal(ret.headers.get("location"), `/order?id=${d.orderId}&status=COMPLETED`);
  const d2 = await (await post("/api/orders", { items: [{ sku: "MUG-STONE-350", quantity: 1 }], flow: "redirect" })).json();
  const c = await fetch(`${base}/paypal/cancel?token=${d2.orderId}`, { redirect: "manual" });
  assert.match(c.headers.get("location")!, /cancelled=1/);
  assert.equal(orders.getOrder(d2.orderId)!.status, "CANCELLED");
});

test("errors map to safe HTTP codes", async () => {
  assert.equal((await fetch(base + "/api/orders", { method: "POST", body: "{bad" })).status, 400);
  assert.equal((await post("/api/orders", { items: [{ sku: "NOPE", quantity: 1 }] })).status, 400);
  assert.equal((await fetch(base + "/api/orders", { method: "POST", body: "x".repeat(20000) })).status, 413);
  assert.equal((await fetch(base + "/api/orders/..%2F..%2Fv1")).status, 400);
  const nf = await fetch(base + "/api/orders/MISSING0001");
  assert.equal(nf.status, 422);
  assert.deepEqual(await nf.json(), { error: "payment provider error: INVALID_RESOURCE_ID", debugId: "dbg" });
});

test("agents need a buyer mandate; the mandate bounds spend; agents cannot mint mandates or capture", async () => {
  const s = "ag_agent0001";
  const noMandate = await post("/api/orders", { items: [{ sku: "TEA-SENCHA-80", quantity: 1 }] }, agentHeaders(s));
  assert.equal(noMandate.status, 403);
  assert.equal((await noMandate.json()).code, "NOT_FOUND");
  assert.equal((await post("/api/mandates", { budget: 100 }, agentHeaders(s))).status, 403);
  const m = await (await post("/api/mandates", { budget: 30, per_order_max: 25 })).json();
  assert.equal(m.remaining, "30.00");
  const over = await post("/api/orders", { items: [{ sku: "KETTLE-GOOSE-1L", quantity: 1 }] }, agentHeaders(s, m.mandateId));
  assert.equal(over.status, 403);
  assert.equal((await over.json()).code, "OVER_PER_ORDER");
  const ok = await post("/api/orders", { items: [{ sku: "TEA-OOLONG-100", quantity: 1 }] }, agentHeaders(s, m.mandateId));
  const od = await ok.json();
  assert.equal(ok.status, 201);
  assert.equal(od.mandate.remaining, "16.00");
  assert.ok(calls.some((c) => c.startsWith(`create ${od.orderId} 14.00 agent:${s}:${m.mandateId} redirect`)));
  const budget = await post("/api/orders", { items: [{ sku: "MUG-STONE-350", quantity: 1 }] }, agentHeaders(s, m.mandateId));
  assert.equal((await budget.json()).code, "OVER_BUDGET");
  assert.equal((await post(`/api/orders/${od.orderId}/capture`, {}, agentHeaders(s))).status, 403);
  // Buyer cancels in PayPal: the money goes back to the mandate.
  await fetch(`${base}/paypal/cancel?token=${od.orderId}`, { redirect: "manual" });
  assert.equal((await (await fetch(`${base}/api/mandates/${m.mandateId}`)).json()).remaining, "30.00");
  assert.equal((await post(`/api/mandates/${m.mandateId}/revoke`, {}, agentHeaders(s))).status, 403);
  assert.equal((await (await post(`/api/mandates/${m.mandateId}/revoke`, {})).json()).status, "REVOKED");
});

test("full agent flow through WebMCP tools: journaled, claim opened, merchant refunds via DisputeDesk", async () => {
  const m = await (await post("/api/mandates", { budget: 50 })).json();
  const tools = Object.fromEntries(buildStoreTools({ base, session: "ag_test0001", getMandate: () => m.mandateId }).map((t: any) => [t.name, t]));
  const parse = (r: any) => JSON.parse(r.content[0].text);
  assert.equal(parse(await tools.get_budget.execute({})).remaining, "50.00");
  const s = parse(await tools.search_products.execute({ query: "green tea", max_price: 12 }));
  assert.equal(s.items[0].sku, "TEA-SENCHA-80");
  const o = parse(await tools.create_order.execute({ items: [{ sku: s.items[0].sku, quantity: 1 }] }));
  // Refund before payment is refused.
  const early = await tools.request_refund.execute({ order_id: o.orderId, note: "changed mind" });
  assert.equal(early.isError, true);
  // Buyer approves in PayPal; the store captures on return.
  await fetch(`${base}/paypal/return?token=${o.orderId}`, { redirect: "manual" });
  assert.equal(parse(await tools.get_order_status.execute({ order_id: o.orderId })).status, "COMPLETED");
  // Another agent session cannot raise a claim on this order.
  const other = Object.fromEntries(buildStoreTools({ base, session: "ag_other0001" }).map((t: any) => [t.name, t]));
  assert.equal((await other.open_dispute.execute({ order_id: o.orderId, reason: "OTHER", note: "x" })).isError, true);
  const claim = parse(await tools.open_dispute.execute({ order_id: o.orderId, reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", note: "tea tastes stale" }));
  assert.match(claim.claimId, /^CLM-/);
  const receipt = await (await fetch(`${base}/api/orders/${o.orderId}/agent-log`)).json();
  assert.deepEqual(receipt.calls.map((c: any) => c.tool), ["get_budget", "search_products", "create_order", "request_refund", "get_order_status", "open_dispute"]);
  assert.equal(receipt.calls[3].ok, false, "failed attempts stay in the agent trail");
  assert.equal(receipt.calls[1].result[0].sku, "TEA-SENCHA-80", "what the agent was shown is journaled");
  const cases = await (await fetch(`${base}/api/merchant/cases`)).json();
  const c = cases.cases.find((x: any) => x.caseId === claim.claimId);
  assert.equal(c.channel, "agent");
  assert.ok(["FIGHT", "ACCEPT"].includes(c.assessment.recommendation));
  assert.match(c.agentSummary, /assembled by the buyer's AI agent/);
  assert.ok(c.agentEvidence.some((e: any) => e.evidence_type === "ITEM_DESCRIPTION" && /TEA-SENCHA-80/.test(e.notes)));
  // Agents cannot use merchant actions.
  assert.equal((await post(`/api/merchant/claims/${claim.claimId}/refund`, {}, agentHeaders("ag_test0001"))).status, 403);
  const refunded = await (await post(`/api/merchant/claims/${claim.claimId}/refund`, {})).json();
  assert.equal(refunded.status, "REFUNDED");
  assert.ok(calls.some((x) => x.startsWith("refund CAP") && x.endsWith(`refund-${claim.claimId}`)));
  assert.equal((await post(`/api/merchant/claims/${claim.claimId}/refund`, {})).status, 409);
  const summary = await (await fetch(`${base}/api/merchant/summary`)).json();
  assert.ok(summary.agentOrders >= 1);
  const journalList = await (await fetch(`${base}/api/merchant/journal`)).json();
  assert.ok(journalList.entries.length >= 6);
});

test("PayPal-side disputes are listed and linked to the store order by capture id", async () => {
  const cases = await (await fetch(`${base}/api/merchant/cases?refresh=1`)).json();
  const pd = cases.cases.find((x: any) => x.source === "paypal");
  assert.equal(pd.caseId, "PP-D-12345");
  assert.equal(pd.orderId, "TESTORDER001");
  assert.equal(pd.assessment.source, "rules");
});

test("order records are rebuilt from PayPal after a restart", async () => {
  const fresh = createHandler({ payments: fakePayments as any, journal: new AgentJournal(), orders: new OrderStore(), mandates: new MandateStore(), baseUrl: "http://x" });
  const srv = createServer(fresh);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const b = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const v = await (await fetch(`${b}/api/orders/TESTORDER001`)).json();
  assert.equal(v.status, "COMPLETED");
  assert.equal(v.channel, "human");
  srv.close();
});

test("agent step endpoint without LLM tells the page to fall back", async () => {
  const r = await post("/api/agent/step", { messages: [{ role: "user", content: "tea" }], tools: [] });
  assert.equal(r.status, 503);
  assert.equal((await r.json()).fallback, true);
});

test("helpers", () => {
  const rl = new RateLimiter(2, 1000);
  assert.ok(rl.allow("a", 0) && rl.allow("a", 1) && !rl.allow("a", 2) && rl.allow("a", 1001));
  assert.equal(maskEmail("sb-123@personal.example.com"), "s***@personal.example.com");
  assert.equal(maskEmail(undefined), null);
  const leaked = maskKeys("gemini LLM HTTP 400 url ?key=AIzaSyA1234567890abcdefghijk&x=1 Bearer abc.def gsk_abcdefghijklmnopqrstuvwxyz AQ.Ab8RN6abcdefghijklmnopqrstuv");
  for (const s of ["AIzaSyA1234567890", "abc.def", "gsk_abcdefghij", "AQ.Ab8RN6abc"]) assert.ok(!leaked.includes(s), s);
});

test("a reloaded PayPal return URL does not capture twice", async () => {
  const o = await (await post("/api/orders", { items: [{ sku: "TEA-SENCHA-80", quantity: 1 }], flow: "redirect" })).json();
  await fetch(`${base}/paypal/return?token=${o.orderId}`, { redirect: "manual" });
  const r = await fetch(`${base}/paypal/return?token=${o.orderId}`, { redirect: "manual" });
  assert.equal(r.status, 302);
  assert.match(r.headers.get("location") ?? "", /status=COMPLETED/);
  assert.equal(calls.filter((x) => x === `capture ${o.orderId}`).length, 1);
});
