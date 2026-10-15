import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentJournal, sanitizeArgs, validSession } from "../src/journal.ts";

test("receipt returns the session trail of the agent that created the order", () => {
  const j = new AgentJournal();
  j.record({ session: "ag_aaaaaa", tool: "search_products", args: { query: "tea" }, ok: true, summary: "3" });
  j.record({ session: "ag_bbbbbb", tool: "search_products", args: { query: "mug" }, ok: true, summary: "1" });
  j.record({ session: "ag_aaaaaa", tool: "create_order", args: { items: [] }, ok: true, summary: "order", orderId: "ORDER0001" });
  j.record({ session: "ag_aaaaaa", tool: "get_order_status", args: {}, ok: true, summary: "s", orderId: "ORDER0001" });
  j.record({ session: "ag_aaaaaa", tool: "get_order_status", args: {}, ok: true, summary: "s", orderId: "ORDER0002" });
  const r = j.receipt("ORDER0001");
  assert.equal(r.session, "ag_aaaaaa");
  assert.deepEqual(r.calls.map((c) => c.tool), ["search_products", "create_order", "get_order_status"]);
  assert.deepEqual(j.receipt("UNKNOWN01").calls, []);
  assert.deepEqual(j.stats(), { calls: 5, sessions: 2, orders: 2 });
});

test("args are sanitized and persisted as JSONL", () => {
  const dir = mkdtempSync(join(tmpdir(), "pas-"));
  const file = join(dir, "sub", "j.jsonl");
  const j = new AgentJournal(file);
  j.record({ session: "ag_cccccc", tool: "t", args: { password: "x", nested: { access_token: "y" }, q: "a".repeat(500) }, ok: true, summary: "" });
  const line = JSON.parse(readFileSync(file, "utf8").trim());
  assert.equal(line.args.password, "***");
  assert.equal(line.args.nested.access_token, "***");
  assert.ok(line.args.q.length < 210);
  assert.equal(sanitizeArgs(() => 1), undefined);
});

test("session id format is enforced", () => {
  assert.ok(validSession("ag_0123456789abcdef"));
  assert.ok(!validSession("x"));
  assert.ok(!validSession("ag_<script>"));
  assert.ok(!validSession(undefined));
});
