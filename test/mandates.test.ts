import { test } from "node:test";
import assert from "node:assert/strict";
import { MandateStore, MandateError, validMandateId } from "../src/mandates.ts";

const T0 = new Date("2026-10-16T10:00:00Z");

test("mandate holds budget, commits orders and reports remaining", () => {
  const s = new MandateStore();
  const m = s.create({ budget: 40, per_order_max: 30, note: "tea for the office" }, T0);
  assert.ok(validMandateId(m.mandateId));
  assert.equal(m.status, "ACTIVE");
  assert.equal(m.remaining, "40.00");
  const r1 = s.reserve(m.mandateId, 25_00, ["tea"], T0);
  // While held, a parallel order cannot use the same money.
  assert.throws(() => s.reserve(m.mandateId, 20_00, ["tea"], T0), (e: any) => e instanceof MandateError && e.code === "OVER_BUDGET");
  r1.commit("ORDER0001");
  assert.equal(s.view(m.mandateId, T0)!.spent, "25.00");
  assert.deepEqual(s.view(m.mandateId, T0)!.orders, ["ORDER0001"]);
  const r2 = s.reserve(m.mandateId, 10_00, ["tea"], T0);
  r2.release();
  assert.equal(s.view(m.mandateId, T0)!.remaining, "15.00");
  assert.ok(s.releaseOrder("ORDER0001"));
  assert.equal(s.view(m.mandateId, T0)!.remaining, "40.00");
});

test("per-order cap, categories, expiry and revocation are enforced", () => {
  const s = new MandateStore();
  const m = s.create({ budget: 100, per_order_max: 20, categories: ["tea"], ttl_minutes: 10 }, T0);
  const code = (fn: () => unknown) => { try { fn(); return "ok"; } catch (e: any) { return e.code; } };
  assert.equal(code(() => s.reserve(m.mandateId, 21_00, ["tea"], T0)), "OVER_PER_ORDER");
  assert.equal(code(() => s.reserve(m.mandateId, 5_00, ["tea", "teaware"], T0)), "CATEGORY_NOT_ALLOWED");
  assert.equal(code(() => s.reserve(m.mandateId, 5_00, ["tea"], new Date(T0.getTime() + 11 * 60_000))), "EXPIRED");
  assert.equal(s.view(m.mandateId, new Date(T0.getTime() + 11 * 60_000))!.status, "EXPIRED");
  s.revoke(m.mandateId);
  assert.equal(code(() => s.reserve(m.mandateId, 5_00, ["tea"], T0)), "REVOKED");
  assert.equal(code(() => s.reserve("md_0000000000000000", 1, [], T0)), "NOT_FOUND");
  assert.equal(code(() => s.reserve("../etc", 1, [], T0)), "NOT_FOUND");
});

test("mandate input validation", () => {
  const s = new MandateStore();
  const bad = (x: any) => assert.throws(() => s.create(x, T0), (e: any) => e.code === "INVALID");
  bad({});
  bad({ budget: -5 });
  bad({ budget: "abc" });
  bad({ budget: 500 });
  bad({ budget: 10, per_order_max: 20 });
  bad({ budget: 10, categories: ["weapons"] });
  bad({ budget: 10, ttl_minutes: 1 });
  bad({ budget: 10, ttl_minutes: 2.5 });
  assert.equal(s.create({ budget: "12.345" }, T0).budget, "12.35");
  assert.equal(s.view("nope"), null);
});
