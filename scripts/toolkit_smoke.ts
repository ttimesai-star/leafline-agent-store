// Live sandbox check of the PayPal Agent Toolkit wiring (read-only): get_order on an order id, list_disputes,
// and a deliberate not-found error. Usage: scripts/with-sandbox-env.sh node scripts/toolkit_smoke.ts [ORDER_ID]
import { PayPalClient, configFromEnv } from "../src/paypal.ts";
import { ToolkitPayments } from "../src/toolkit.ts";

const cfg = configFromEnv();
const own = new PayPalClient(cfg);
const kit = new ToolkitPayments({ token: () => own.getAccessToken(), secrets: [cfg.clientId, cfg.secret] });
const orderId = process.argv[2] ?? "28Y33417NX865202K";
const o = await kit.getOrder(orderId);
console.log("get_order", o.id, o.status, "capture", o.purchase_units?.[0]?.payments?.captures?.[0]?.id ?? "-");
const d = await kit.listDisputes(5);
console.log("list_disputes", (d.items ?? []).length, "item(s)");
try {
  await kit.getOrder("AAAAAAAAAAAAAAAAA");
  console.log("UNEXPECTED: missing order returned a result");
  process.exitCode = 1;
} catch (e) {
  console.log("missing order -> error as expected:", (e as Error).message.slice(0, 120));
}
for (const c of kit.calls().reverse()) console.log(`  ${c.tool} ok=${c.ok} ${c.status ?? ""} ${c.ms}ms`);
