import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStoreTools, registerStoreTools, findModelContext, makeSessionId, callTool, TOOL_NAMES } from "../web/webmcp.js";

const tools = buildStoreTools({ fetchImpl: (async () => new Response("{}")) as any, session: "ag_x000001" });

test("six tools with JSON schemas", () => {
  assert.deepEqual(tools.map((t: any) => t.name), TOOL_NAMES);
  for (const t of tools as any[]) {
    assert.equal(t.inputSchema.type, "object");
    assert.ok(t.description.length > 20);
    assert.equal(typeof t.execute, "function");
  }
  assert.match(makeSessionId(), /^ag_[0-9a-f]{24}$/);
});

test("registers via registerTool, provideContext, or reports why not", async () => {
  const seen: string[] = [];
  assert.deepEqual(await registerStoreTools({ registerTool: (t: any) => seen.push(t.name) }, tools), { ok: true, mode: "registerTool", tools: seen });
  let ctx: any;
  const r2 = await registerStoreTools({ provideContext: (c: any) => (ctx = c) }, tools);
  assert.equal(r2.mode, "provideContext");
  assert.equal(ctx.tools.length, 6);
  assert.equal((await registerStoreTools(null, tools)).ok, false);
  const r4 = await registerStoreTools({ registerTool: () => { throw new DOMException("not allowed", "NotAllowedError"); } }, tools);
  assert.deepEqual([r4.ok, r4.mode], [false, "error"]);
  assert.match(r4.error, /NotAllowedError/);
});

test("findModelContext prefers document (current spec) then navigator", () => {
  assert.equal(findModelContext({ navigator: { modelContext: 1 }, document: { modelContext: 2 } }), 2);
  assert.equal(findModelContext({ navigator: { modelContext: 1 }, document: {} }), 1);
  assert.equal(findModelContext({}), null);
});

test("tool calls carry agent + mandate headers, encode ids, report to onCall", async () => {
  const seen: any[] = [];
  const events: any[] = [];
  const t = buildStoreTools({
    fetchImpl: (async (u: string, i: any) => { seen.push([u, i.headers, i.body]); return new Response(JSON.stringify({ ok: 1 })); }) as any,
    session: "ag_y000001",
    getMandate: () => "md_0123456789abcdef",
    onCall: (e: any) => events.push(e),
  });
  const byName = Object.fromEntries(t.map((x: any) => [x.name, x]));
  await byName.get_order_status.execute({ order_id: "../x" });
  assert.equal(seen[0][0], "/api/orders/..%2Fx");
  assert.equal(seen[0][1]["x-agent-session"], "ag_y000001");
  assert.equal(seen[0][1]["x-agent-tool"], "get_order_status");
  assert.equal(seen[0][1]["x-agent-mandate"], "md_0123456789abcdef");
  await byName.open_dispute.execute({ order_id: "ABCDEFGH12", reason: "OTHER", note: "n" });
  assert.equal(seen[1][0], "/api/orders/ABCDEFGH12/claims");
  assert.deepEqual(JSON.parse(seen[1][2]), { kind: "DISPUTE", reason: "OTHER", note: "n" });
  await byName.get_budget.execute({});
  assert.equal(seen[2][0], "/api/mandates/md_0123456789abcdef");
  assert.deepEqual(events.map((e) => [e.tool, e.ok]), [["get_order_status", true], ["open_dispute", true], ["get_budget", true]]);
});

test("get_budget without mandate is an error, network errors do not throw", async () => {
  const t = Object.fromEntries(buildStoreTools({ fetchImpl: (async () => { throw new Error("offline"); }) as any }).map((x: any) => [x.name, x]));
  assert.equal((await t.get_budget.execute({})).isError, true);
  const r = await t.search_products.execute({ query: "tea" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /offline/);
});

test("callTool goes through modelContext.executeTool when available", async () => {
  const used: string[] = [];
  const mc = {
    async getTools() { return [{ name: "search_products" }]; },
    async executeTool(reg: any, args: any) { used.push(reg.name + JSON.stringify(args)); return JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ items: [] }) }] }); },
  };
  const r = await callTool(mc, tools, "search_products", { query: "tea" });
  assert.deepEqual(r, { isError: false, payload: { items: [] } });
  assert.deepEqual(used, ['search_products{"query":"tea"}']);
  await assert.rejects(() => callTool(mc, tools, "create_order", {}), /not registered/);
  const local = await callTool(null, buildStoreTools({ fetchImpl: (async () => new Response(JSON.stringify({ a: 1 }))) as any }), "search_products", { query: "x" });
  assert.deepEqual(local.payload, { a: 1 });
});
