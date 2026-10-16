# paypal-agent-store (spike)

Status: **prototype / spike**, PayPal **sandbox only**, not audited. Not a product.

An agent-ready storefront: a small shop on PayPal Orders v2 that exposes its actions to AI agents as
WebMCP tools (`search_products`, `create_order`, `get_order_status`), and keeps a per-order journal of
every agent tool call ("agent receipt") for the merchant and for later dispute evidence.

Design rules:
- Prices are computed on the server from the catalog; clients and agents only send `sku` + `quantity`.
- An agent can create an order but cannot pay: the buyer approves in PayPal, the merchant server captures.
- Sandbox host is enforced in code (`assertSandbox`); live endpoints are rejected.
- Credentials come from env only (`scripts/with-sandbox-env.sh` reads a file outside the repo).

## Run

```sh
npm test                                     # unit + HTTP tests, no network
scripts/with-sandbox-env.sh node src/server.ts   # http://localhost:8787
python scripts/webmcp_probe.py --flags --call     # Chrome with WebMCP flag: tools -> sandbox order -> receipt
```

WebMCP (verified 2026-10-16, Chrome 155): native API is `document.modelContext` and only exists with
`--enable-features=WebMCP,WebMCPTesting` (chrome://flags/#enable-webmcp-testing). Without the flag the
MCP-B polyfill (`@mcp-b/global`, MIT) provides the same surface.

License: MIT.

## Sandbox end-to-end (16.10.2026)
With US sandbox accounts (Business + Personal) and a Merchant app on the US Business account, the full cycle works:
create order -> buyer approval (`scripts/sandbox_approve.py`) -> capture -> `COMPLETED`
(order `28Y33417NX865202K`, capture `6LC221476A3697515`, USD 3.00). Accounts created with country BY could not complete payments.
Credentials are read from `~/.claude/secrets/paypal_sandbox.json` by `scripts/with-sandbox-env.sh` (never committed).
