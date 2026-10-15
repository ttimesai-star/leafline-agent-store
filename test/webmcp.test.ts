import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStoreTools, registerStoreTools, findModelContext, makeSessionId } from "../web/webmcp.js";

const tools = buildStoreTools({ fetchImpl: (async () => new Response("{}")) as any, session: "ag_x000001" });

test("three tools with JSON schemas", () => {
  assert.deepEqual(tools.map((t: any) => t.name), ["search_products", "create_order", "get_order_status"]);
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
  assert.equal(ctx.tools.length, 3);
  assert.equal((await registerStoreTools(null, tools)).ok, false);
  const r4 = await registerStoreTools({ registerTool: () => { throw new DOMException("not allowed", "NotAllowedError"); } }, tools);
  assert.deepEqual([r4.ok, r4.mode], [false, "error"]);
  assert.match(r4.error, /NotAllowedError/);
});

test("findModelContext prefers navigator then document", () => {
  assert.equal(findModelContext({ navigator: { modelContext: 1 }, document: { modelContext: 2 } }), 1);
  assert.equal(findModelContext({ navigator: {}, document: { modelContext: 2 } }), 2);
  assert.equal(findModelContext({}), null);
});

test("tool calls carry agent headers and encode order ids", async () => {
  const seen: any[] = [];
  const t = buildStoreTools({
    fetchImpl: (async (u: string, i: any) => { seen.push([u, i.headers]); return new Response(JSON.stringify({ ok: 1 })); }) as any,
    session: "ag_y000001",
  });
  await t[2].execute({ order_id: "../x" });
  assert.equal(seen[0][0], "/api/orders/..%2Fx");
  assert.equal(seen[0][1]["x-agent-session"], "ag_y000001");
  assert.equal(seen[0][1]["x-agent-tool"], "get_order_status");
});
