// Live sandbox smoke: `create` makes a 1-item order; `capture <id>` captures an approved order;
// `get <id>` prints status. Prints only ids/status/links, never credentials.
import { PayPalClient, configFromEnv, approveLink } from "../src/paypal.ts";

const [cmd = "create", id] = process.argv.slice(2);
const pp = new PayPalClient(configFromEnv());
const out = (o: any) => console.log(JSON.stringify(o));
try {
  if (cmd === "create") {
    const o = await pp.createOrder({
      currency: "USD",
      total: "3.00",
      items: [{ sku: "SPIKE-1", name: "Spike test item", unitPrice: "1.50", quantity: 2 }],
      referenceId: "spike",
      returnUrl: "http://localhost:8787/paypal/return",
      cancelUrl: "http://localhost:8787/paypal/cancel",
    }, `spike-${Date.now()}`);
    out({ id: o.id, status: o.status, approve: approveLink(o) });
  } else if (cmd === "get") {
    const o = await pp.getOrder(id!);
    out({ id: o.id, status: o.status, payer: o.payer?.payer_id ? "present" : "none" });
  } else if (cmd === "capture") {
    const o = await pp.captureOrder(id!, `cap-${id}`);
    const cap = o.purchase_units?.[0]?.payments?.captures?.[0];
    out({ id: o.id, status: o.status, capture_id: cap?.id, capture_status: cap?.status, amount: cap?.amount });
  }
} catch (e: any) {
  out({ error: e.message, status: e.status, issue: e.issue, debug_id: e.debugId });
  process.exitCode = 1;
}
