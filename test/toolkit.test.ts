import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolkitPayments, enabledToolkitTools, realToolkitApi, toolkitError, MERCHANT_TOOLS, type ToolkitApi } from "../src/toolkit.ts";
import { PayPalError } from "../src/paypal.ts";

function fakeKit(reply: (method: string, arg: any, token: string, requestId?: string) => unknown) {
  const made: Array<{ token: string; requestId?: string }> = [];
  const runs: Array<{ method: string; arg: any; token: string; requestId?: string }> = [];
  const makeApi = (token: string, requestId?: string): ToolkitApi => {
    made.push({ token, requestId });
    return {
      async run(method, arg) {
        runs.push({ method, arg, token, requestId });
        return JSON.stringify(reply(method, arg, token, requestId));
      },
    };
  };
  return { made, runs, makeApi };
}

test("our action config enables exactly the six merchant tools in the real Toolkit", () => {
  assert.deepEqual([...enabledToolkitTools()].sort(), [...MERCHANT_TOOLS].sort());
});

test("real Toolkit API is pinned to the sandbox host and carries request_id", () => {
  const api = realToolkitApi("tok", "refund-CLM-1") as any;
  assert.match(api.paypalClient.getBaseUrl(), /sandbox\.paypal\.com$/);
  assert.equal(api.context.request_id, "refund-CLM-1");
  assert.equal(api.context.sandbox, true);
});

test("calls go through the Toolkit with validated args and are logged without payloads", async () => {
  const k = fakeKit((m, a) => (m === "get_order" ? { id: a.id, status: "COMPLETED" } : { items: [] }));
  const tp = new ToolkitPayments({ token: async () => "T1", makeApi: k.makeApi });
  assert.equal((await tp.getOrder("ABCDEFGH12")).status, "COMPLETED");
  await tp.listDisputes(500);
  assert.deepEqual(k.runs.map((r) => [r.method, r.arg]), [["get_order", { id: "ABCDEFGH12" }], ["list_disputes", { page_size: 50 }]]);
  assert.equal(k.made.length, 1, "one Toolkit API per token");
  const log = tp.calls();
  assert.equal(log.length, 2);
  assert.equal(log[0].tool, "list_disputes");
  assert.ok(log.every((c) => c.ok && !("arg" in c)));
  await assert.rejects(() => tp.getOrder("../x"), /invalid PayPal order id/);
  await assert.rejects(async () => tp.getDispute("PP-D-1/../../x"), /invalid PayPal dispute id/);
  await assert.rejects(async () => tp.refundCapture("bad id"), /invalid PayPal capture id/);
  assert.equal(k.runs.length, 2, "invalid ids never reach the Toolkit");
});

test("tools outside the allow-list are refused before run() (Toolkit itself would execute them)", async () => {
  const k = fakeKit(() => ({}));
  const tp = new ToolkitPayments({ token: async () => "T", makeApi: k.makeApi });
  await assert.rejects(() => tp.call("pay_order" as any, { id: "ABCDEFGH12" }), /not allowed/);
  await assert.rejects(() => tp.call("create_order" as any, {}), /not allowed/);
  assert.equal(k.runs.length, 0);
});

test("refund uses its own PayPal-Request-Id and the refund argument shape of Toolkit 1.11.0", async () => {
  const k = fakeKit((_m, a) => ({ id: "REFUND00001", status: "COMPLETED", amount: { value: "4.00" }, echo: a }));
  const tp = new ToolkitPayments({ token: async () => "T", makeApi: k.makeApi });
  const r = await tp.refundCapture("CAP0001XXXXX", { note: "x".repeat(400) }, "refund-CLM-0000ABCD");
  assert.equal(r.status, "COMPLETED");
  assert.equal(k.made[0].requestId, "refund-CLM-0000ABCD");
  assert.equal(k.runs[0].arg.capture_id, "CAP0001XXXXX");
  assert.equal(k.runs[0].arg.note_to_payer.length, 255);
  assert.equal(k.runs[0].arg.amount, undefined, "full refund");
  await tp.refundCapture("CAP0001XXXXX", { amount: "1.50" });
  assert.deepEqual(k.runs[1].arg.amount, { value: "1.50", currency_code: "USD" });
  await assert.rejects(() => tp.refundCapture("CAP0001XXXXX", {}, "bad id with spaces"), /PayPal-Request-Id/);
});

test("Toolkit error strings become PayPalError; 401 drops the cached token API", async () => {
  let tok = "OLD";
  const k = fakeKit((m, _a, token) => (token === "OLD" ? { ok: false, status: 401, code: "PAYPAL_API_HTTP_ERROR", message: "Authentication failed" } : m === "get_dispute" ? { error: { message: "boom", type: "paypal_error" } } : { id: "ABCDEFGH12", status: "CREATED" }));
  const tp = new ToolkitPayments({ token: async () => tok, makeApi: k.makeApi, secrets: ["SECRETVALUE"] });
  await assert.rejects(() => tp.getOrder("ABCDEFGH12"), (e: any) => e instanceof PayPalError && e.status === 401 && e.issue === "PAYPAL_API_HTTP_ERROR");
  tok = "NEW";
  assert.equal((await tp.getOrder("ABCDEFGH12")).status, "CREATED");
  assert.equal(k.made.length, 2, "rebuilt with the new token");
  await assert.rejects(() => tp.getDispute("PP-D-123456"), (e: any) => e instanceof PayPalError && /boom/.test(e.message));
  assert.equal(tp.calls()[0].ok, false);
});

test("thrown errors are redacted", async () => {
  const tp = new ToolkitPayments({
    token: async () => "TOKENVALUE123",
    secrets: ["SECRETVALUE"],
    makeApi: () => ({ async run() { throw new Error("failed with SECRETVALUE and Bearer abc.def"); } }),
  });
  await assert.rejects(() => tp.getRefund("REFUND00001"), (e: any) => e instanceof PayPalError && !/SECRETVALUE|abc\.def/.test(e.message));
});

test("toolkitError recognises both Toolkit error shapes and passes normal results", () => {
  assert.deepEqual(toolkitError({ ok: false, status: 422, code: "X", message: "m" }), { status: 422, code: "X", message: "m" });
  assert.deepEqual(toolkitError({ error: { message: "e" } }), { message: "e" });
  assert.equal(toolkitError({ id: "X", status: "COMPLETED" }), null);
  assert.equal(toolkitError({ error: "invalid_token" }), null, "string error fields are not Toolkit errors");
  assert.ok(toolkitError(null));
});

test("accept_dispute_claim sends a cleaned note", async () => {
  const k = fakeKit(() => ({ links: [] }));
  const tp = new ToolkitPayments({ token: async () => "T", makeApi: k.makeApi });
  await tp.acceptDisputeClaim("PP-D-123456", "line1\nline2");
  assert.deepEqual(k.runs[0].arg, { dispute_id: "PP-D-123456", note: "line1 line2" });
  await tp.acceptDisputeClaim("PP-D-123456", "  ");
  assert.equal(k.runs[1].arg.note, "Claim accepted by the merchant.");
});
