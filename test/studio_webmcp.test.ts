import { test } from "node:test";
import assert from "node:assert/strict";
import { toWebMcpTools } from "../web/studio_webmcp.js";

const tool = (name: string, parameters: any, result: any) => ({
  name,
  description: name,
  kind: "client",
  schema: () => ({ name, description: `does ${name}`, parameters }),
  execute: async (call: any, ctx: any) => (typeof result === "function" ? result(call, ctx) : result),
});

test("Studio AI tools become read-only WebMCP tools with a prefix; object roots kept, anyOf roots nested", async () => {
  const seen: any[] = [];
  const tools = toWebMcpTools([
    tool("view_schema", { type: "object", properties: {} }, (_c: any, ctx: any) => ctx.success("schema text", { n: 1 })),
    tool("execute_query", { anyOf: [{ type: "object" }, { type: "object" }] }, (c: any, ctx: any) => (seen.push(c.args), ctx.success("ok"))),
    tool("broken", { type: "object", properties: {} }, (_c: any, ctx: any) => ctx.error(["bad field"])),
    { name: "uncallable", schema: () => undefined, execute: async () => ({}) },
  ]);
  assert.deepEqual(tools.map((t) => t.name), ["dashboard_view_schema", "dashboard_execute_query", "dashboard_broken"]);
  assert.ok(tools.every((t) => t.annotations.readOnlyHint === true));
  assert.equal(tools[1].inputSchema.type, "object");
  assert.deepEqual(tools[1].inputSchema.required, ["query"]);
  const ok = JSON.parse((await tools[0].execute({})).content[0].text);
  assert.deepEqual(ok, { response: "schema text", data: { n: 1 } });
  await tools[1].execute({ query: { variant: "projection" } });
  assert.deepEqual(seen, [{ variant: "projection" }], "nested query unwrapped before Studio sees it");
  const bad = await tools[2].execute({});
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /bad field/);
});
