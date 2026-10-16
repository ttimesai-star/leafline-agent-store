import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHandler } from "../src/server.ts";
import { AgentJournal } from "../src/journal.ts";
import { OrderStore } from "../src/orders.ts";
import { MandateStore } from "../src/mandates.ts";

const payments = {
  clientId: "PUBLIC-CLIENT-ID",
  toolkit: { package: "@paypal/agent-toolkit", version: "1.11.0", tools: [] },
  toolkitCalls: () => [],
  async listDisputes() {
    return { items: [] };
  },
};

async function withServer(opts: { merchantKey?: string; publicMerchantView?: boolean }, fn: (base: string) => Promise<void>) {
  const srv = createServer(createHandler({ payments: payments as any, journal: new AgentJournal(), orders: new OrderStore(), mandates: new MandateStore(), baseUrl: "http://x", ...opts }));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  try {
    await fn(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((r) => {
      srv.closeAllConnections();
      srv.close(() => r());
    });
  }
}

const VIEWS = ["/api/merchant/orders", "/api/merchant/journal", "/api/merchant/summary", "/api/merchant/cases", "/api/merchant/toolkit"];
const agent = { "x-agent-tool": "search_products", "x-agent-session": "ag_key00001" };

test("no MERCHANT_KEY: views open to people, closed to agents; config says none", async () => {
  await withServer({}, async (base) => {
    assert.equal((await (await fetch(`${base}/api/config`)).json()).merchantKey, "none");
    for (const p of VIEWS) {
      assert.equal((await fetch(base + p)).status, 200, p);
      assert.equal((await fetch(base + p, { headers: agent })).status, 403, `${p} agent`);
    }
  });
});

test("MERCHANT_KEY set: every view needs the key, wrong key is 401, right key is 200", async () => {
  await withServer({ merchantKey: "s3cret-key" }, async (base) => {
    assert.equal((await (await fetch(`${base}/api/config`)).json()).merchantKey, "all");
    for (const p of VIEWS) {
      assert.equal((await fetch(base + p)).status, 401, p);
      assert.equal((await fetch(base + p, { headers: { "x-merchant-key": "s3cret-kez" } })).status, 401, `${p} wrong`);
      assert.equal((await fetch(base + p, { headers: { "x-merchant-key": "s3cret-key" } })).status, 200, `${p} right`);
      assert.equal((await fetch(base + p, { headers: { ...agent, "x-merchant-key": "s3cret-key" } })).status, 403, `${p} agent with key`);
    }
  });
});

test("public demo view: views readable without the key, actions still need it", async () => {
  await withServer({ merchantKey: "s3cret-key", publicMerchantView: true }, async (base) => {
    assert.equal((await (await fetch(`${base}/api/config`)).json()).merchantKey, "actions");
    for (const p of VIEWS) assert.equal((await fetch(base + p)).status, 200, p);
    const act = await fetch(`${base}/api/merchant/claims/CLM-0000ABCD/decline`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(act.status, 401);
    const withKey = await fetch(`${base}/api/merchant/claims/CLM-0000ABCD/decline`, { method: "POST", headers: { "content-type": "application/json", "x-merchant-key": "s3cret-key" }, body: "{}" });
    assert.equal(withKey.status, 404, "past the key check, the claim simply does not exist");
  });
});
