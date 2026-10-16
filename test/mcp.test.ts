// External agent over MCP, with the official MCP SDK client, against the real store handler (PayPal faked):
// Streamable HTTP at /mcp and the stdio server (spawned as a child process). Same mandates as WebMCP.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHandler } from "../src/server.ts";
import { AgentJournal } from "../src/journal.ts";
import { OrderStore } from "../src/orders.ts";
import { MandateStore } from "../src/mandates.ts";
import { mcpSessionFor } from "../src/mcp.ts";

const created: string[] = [];
let seq = 0;
const fakePayments = {
  clientId: "PUBLIC",
  async createOrder(input: any) {
    const id = `MCPORDER${String(++seq).padStart(4, "0")}`;
    created.push(`${id} ${input.total} ${input.customId}`);
    return { id, status: "PAYER_ACTION_REQUIRED", purchase_units: [{ reference_id: "store", custom_id: input.customId, amount: { value: input.total, currency_code: "USD" } }], links: [{ rel: "payer-action", href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] };
  },
  async getOrder(id: string) {
    return { id, status: "PAYER_ACTION_REQUIRED", purchase_units: [{ reference_id: "store" }] };
  },
  async captureOrder() {
    throw new Error("must not be called");
  },
  async refundCapture() {
    throw new Error("must not be called");
  },
  async listDisputes() {
    return { items: [] };
  },
  async getDispute() {
    return {};
  },
};

const journal = new AgentJournal();
let server: Server;
let base = "";
before(async () => {
  server = createServer(createHandler({ payments: fakePayments as any, journal, orders: new OrderStore(), mandates: new MandateStore(), baseUrl: "http://localhost:0" }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((r) => {
    server.closeAllConnections();
    server.close(() => r());
  });
});

const mandate = async (body: unknown) => (await (await fetch(`${base}/api/mandates`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as any;
const payload = (r: any) => JSON.parse(r.content[0].text);

async function httpClient(headers: Record<string, string> = {}) {
  const client = new Client({ name: "test-external-agent", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
  return client;
}

test("HTTP MCP: six tools; order inside the mandate; over-budget, per-order and category refusals", async () => {
  const m = await mandate({ budget: 20, per_order_max: 15, categories: ["tea", "coffee"] });
  const client = await httpClient({ "x-agent-mandate": m.mandateId });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["create_order", "get_budget", "get_order_status", "open_dispute", "request_refund", "search_products"]);
  assert.equal(tools.find((t) => t.name === "search_products")!.annotations?.readOnlyHint, true);
  assert.match(client.getInstructions() ?? "", /mandate/);

  assert.equal(payload(await client.callTool({ name: "get_budget", arguments: {} })).remaining, "20.00");
  const found = payload(await client.callTool({ name: "search_products", arguments: { query: "green tea", max_price: 12 } }));
  assert.equal(found.items[0].sku, "TEA-SENCHA-80");

  const ok = await client.callTool({ name: "create_order", arguments: { items: [{ sku: "TEA-SENCHA-80", quantity: 1 }] } });
  assert.ok(!ok.isError);
  const order = payload(ok);
  assert.equal(order.total, "11.50 USD");
  assert.match(order.approveUrl, /^https:\/\/www\.sandbox\.paypal\.com\//);
  assert.equal(order.mandate.remaining, "8.50");
  const session = mcpSessionFor(undefined, m.mandateId);
  assert.ok(created.some((c) => c === `${order.orderId} 11.50 agent:${session}:${m.mandateId}`), "order tagged with MCP session + mandate");

  const over = await client.callTool({ name: "create_order", arguments: { items: [{ sku: "TEA-OOLONG-100", quantity: 1 }] } });
  assert.equal(over.isError, true);
  assert.equal(payload(over).code, "OVER_BUDGET");
  const perOrder = await client.callTool({ name: "create_order", arguments: { items: [{ sku: "TEA-SENCHA-80", quantity: 2 }] } });
  assert.equal(payload(perOrder).code, "OVER_PER_ORDER");
  const cat = await client.callTool({ name: "create_order", arguments: { items: [{ sku: "MUG-STONE-350", quantity: 1 }] } });
  assert.equal(payload(cat).code, "CATEGORY_NOT_ALLOWED");

  const receipt = await (await fetch(`${base}/api/orders/${order.orderId}/agent-log`)).json();
  assert.deepEqual(receipt.calls.map((c: any) => [c.tool, c.ok]), [["get_budget", true], ["search_products", true], ["create_order", true], ["create_order", false], ["create_order", false], ["create_order", false]], "refusals stay in the agent trail");
  assert.equal(receipt.session, session);
  const unknown = await client.callTool({ name: "capture_order", arguments: { order_id: order.orderId } });
  assert.equal(unknown.isError, true);
  await client.close();
});

test("HTTP MCP: no mandate -> search only; bearer mandate works; revoked mandate is refused; GET is 405", async () => {
  const anon = await httpClient();
  assert.equal((await anon.callTool({ name: "get_budget", arguments: {} })).isError, true);
  const r = await anon.callTool({ name: "create_order", arguments: { items: [{ sku: "TEA-SENCHA-80", quantity: 1 }] } });
  assert.equal(payload(r).code, "NOT_FOUND");
  await anon.close();

  const m = await mandate({ budget: 50 });
  const bearer = await httpClient({ authorization: `Bearer ${m.mandateId}` });
  assert.equal(payload(await bearer.callTool({ name: "get_budget", arguments: {} })).budget, "50.00");
  await fetch(`${base}/api/mandates/${m.mandateId}/revoke`, { method: "POST" });
  const rv = await bearer.callTool({ name: "create_order", arguments: { items: [{ sku: "TEA-SENCHA-80", quantity: 1 }] } });
  assert.equal(payload(rv).code, "REVOKED");
  await bearer.close();

  assert.equal((await fetch(`${base}/mcp`)).status, 405);
  // A forged internal header does not change the client IP used for rate limiting.
  const forged = await fetch(`${base}/api/products?q=tea`, { headers: { "x-internal-mcp": "0".repeat(32), "x-mcp-client-ip": "1.2.3.4" } });
  assert.equal(forged.status, 200);
});

test("stdio MCP server (child process) orders within the mandate and is refused over budget", async () => {
  const m = await mandate({ budget: 12 });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/mcp-stdio.ts", import.meta.url))],
    env: { ...process.env, STORE_URL: base, STORE_MANDATE: m.mandateId, STORE_AGENT_SESSION: "ag_stdiotest01" } as Record<string, string>,
    stderr: "pipe",
  });
  const client = new Client({ name: "stdio-agent", version: "1.0.0" });
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 6);
  const ok = payload(await client.callTool({ name: "create_order", arguments: { items: [{ sku: "TEA-SENCHA-80", quantity: 1 }] } }));
  assert.equal(ok.mandate.remaining, "0.50");
  assert.ok(created.some((c) => c === `${ok.orderId} 11.50 agent:ag_stdiotest01:${m.mandateId}`));
  const over = await client.callTool({ name: "create_order", arguments: { items: [{ sku: "TEA-SENCHA-80", quantity: 1 }] } });
  assert.equal(payload(over).code, "OVER_BUDGET");
  await client.close();
});
