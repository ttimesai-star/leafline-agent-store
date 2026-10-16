import { test } from "node:test";
import assert from "node:assert/strict";
import { PayPalClient, PayPalError, assertSandbox, configFromEnv, redact, approveLink, assertOrderId } from "../src/paypal.ts";

const CID = "client-id-abcdef123456";
const SEC = "secret-value-zyx987654";

function fakeFetch(handlers: Array<(url: string, init: RequestInit) => Response | Promise<Response>>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const h = handlers.shift();
    if (!h) throw new Error("unexpected fetch " + url);
    return h(url, init);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const tokenOk = () => json(200, { access_token: "A21AAtoken-xyz", expires_in: 32400 });

test("sandbox guard rejects live and foreign hosts", () => {
  assert.equal(assertSandbox("https://api-m.sandbox.paypal.com"), "https://api-m.sandbox.paypal.com");
  assert.throws(() => assertSandbox("https://api-m.paypal.com"), /sandbox/);
  assert.throws(() => assertSandbox("http://api-m.sandbox.paypal.com"), /sandbox/);
  assert.throws(() => assertSandbox("https://api-m.sandbox.paypal.com.evil.io"), /sandbox/);
  assert.throws(() => new PayPalClient({ clientId: CID, secret: SEC, base: "https://api-m.paypal.com" }), /sandbox/);
});

test("configFromEnv requires both keys and defaults to sandbox", () => {
  assert.throws(() => configFromEnv({}), /must be set/);
  const c = configFromEnv({ PAYPAL_CLIENT_ID: CID, PAYPAL_CLIENT_SECRET: SEC });
  assert.equal(c.base, "https://api-m.sandbox.paypal.com");
  assert.throws(() => configFromEnv({ PAYPAL_CLIENT_ID: CID, PAYPAL_CLIENT_SECRET: SEC, PAYPAL_API_BASE: "https://api-m.paypal.com" }), /sandbox/);
});

test("redact hides secrets and auth headers", () => {
  const s = redact(`Basic Y2xpZW50 Bearer A21AA.tok-en ${SEC} ${CID}`, [SEC, CID]);
  assert.ok(!s.includes(SEC) && !s.includes(CID) && !s.includes("A21AA") && !s.includes("Y2xpZW50"));
});

test("order id validation blocks path injection", () => {
  assert.equal(assertOrderId("5O190127TN364715T"), "5O190127TN364715T");
  assert.throws(() => assertOrderId("../v1/oauth2"), /invalid/);
  assert.throws(() => assertOrderId("abc"), /invalid/);
});

test("createOrder sends CAPTURE intent with item breakdown and caches token", async () => {
  const { fn, calls } = fakeFetch([
    tokenOk,
    (_u, init) => {
      const body = JSON.parse(String(init.body));
      assert.equal(body.intent, "CAPTURE");
      assert.equal(body.purchase_units[0].amount.value, "30.00");
      assert.equal(body.purchase_units[0].items.length, 2);
      assert.equal(body.payment_source.paypal.experience_context.return_url, "http://localhost/r");
      return json(201, { id: "5O190127TN364715T", status: "PAYER_ACTION_REQUIRED", links: [{ rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T" }] });
    },
    () => json(200, { id: "5O190127TN364715T", status: "APPROVED" }),
  ]);
  const pp = new PayPalClient({ clientId: CID, secret: SEC, fetchImpl: fn });
  const order = await pp.createOrder({
    currency: "USD",
    total: "30.00",
    items: [
      { sku: "a", name: "A", unitPrice: "10.00", quantity: 1 },
      { sku: "b", name: "B", unitPrice: "10.00", quantity: 2 },
    ],
    returnUrl: "http://localhost/r",
    cancelUrl: "http://localhost/c",
  }, "req-1");
  assert.equal(approveLink(order), "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T");
  assert.equal((calls[1].init.headers as Record<string, string>)["PayPal-Request-Id"], "req-1");
  const got = await pp.getOrder("5O190127TN364715T");
  assert.equal(got.status, "APPROVED");
  assert.equal(calls.filter((c) => c.url.endsWith("/v1/oauth2/token")).length, 1, "token reused");
});

test("createOrder refuses a total that does not match items", async () => {
  const pp = new PayPalClient({ clientId: CID, secret: SEC, fetchImpl: fakeFetch([]).fn });
  assert.throws(() => pp.createOrder({ currency: "USD", total: "1.00", items: [{ sku: "a", name: "A", unitPrice: "2.00", quantity: 1 }] }), /does not match/);
});

test("capture errors surface PayPal issue without leaking secrets", async () => {
  const { fn } = fakeFetch([
    tokenOk,
    () => json(422, { name: "UNPROCESSABLE_ENTITY", debug_id: "dbg123", details: [{ issue: "ORDER_NOT_APPROVED" }], echo: SEC }),
  ]);
  const pp = new PayPalClient({ clientId: CID, secret: SEC, fetchImpl: fn });
  await assert.rejects(pp.captureOrder("5O190127TN364715T"), (e: unknown) => {
    assert.ok(e instanceof PayPalError);
    assert.equal(e.status, 422);
    assert.equal(e.issue, "ORDER_NOT_APPROVED");
    assert.equal(e.debugId, "dbg123");
    assert.ok(!e.message.includes(SEC));
    return true;
  });
});

test("network failure message is redacted", async () => {
  const { fn } = fakeFetch([() => { throw new Error(`connect failed for ${CID}:${SEC}`); }]);
  const pp = new PayPalClient({ clientId: CID, secret: SEC, fetchImpl: fn });
  await assert.rejects(pp.getAccessToken(), (e: Error) => !e.message.includes(SEC) && !e.message.includes(CID));
});

test("concurrent calls share one OAuth token request", async () => {
  const f = fakeFetch([tokenOk, () => json(200, { id: "O1", status: "CREATED" }), () => json(200, { id: "O2", status: "CREATED" })]);
  const c = new PayPalClient({ clientId: CID, secret: SEC, fetchImpl: f.fn });
  await Promise.all([c.getOrder("ORDER0000001"), c.getOrder("ORDER0000002")]);
  assert.equal(f.calls.filter((x) => x.url.endsWith("/v1/oauth2/token")).length, 1);
});
