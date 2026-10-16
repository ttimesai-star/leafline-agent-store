# paypal-agent-store (spike)

Status: **prototype / spike**, PayPal **sandbox only**, not audited. Not a product.

An agent-ready storefront: a small shop on PayPal Orders v2 that exposes its actions to AI agents as
WebMCP tools (`search_products`, `get_budget`, `create_order`, `get_order_status`, `request_refund`,
`open_dispute`), and keeps a per-order journal of every agent tool call ("agent receipt") for the merchant
and for later dispute evidence. The buyer delegates a spending mandate (budget, per-order cap, categories,
expiry, revoke) that the server enforces on every agent order; post-purchase claims go to a DisputeDesk
module that cites the agent journal as evidence.

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
scripts/with-sandbox-env.sh python scripts/e2e_browser.py --flags   # full browser E2E against the running store
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

## Browser end-to-end (16.10.2026, sandbox, headless Chrome 155 with the WebMCP flag)
`scripts/e2e_browser.py` passed 10/10 twice in a row: human checkout through the JS SDK v6 PayPal button (popup,
sandbox buyer approves, store captures, COMPLETED); buyer delegates a 40 USD mandate; the in-page agent
(LLM planner, Gemini via the OpenAI-compatible API) calls `get_budget` / `search_products` / `create_order`
through WebMCP; the buyer approves the agent's order in PayPal (COMPLETED, 4 journaled calls on the receipt);
an over-budget agent order is refused by the server (403 OVER_BUDGET); the buyer opens a "not as described"
claim; the merchant panel shows the DisputeDesk case with evidence from the agent journal; the merchant refunds
through PayPal (sandbox refund COMPLETED).
Known flakiness, handled and printed as `NOTE` by the script, never hidden: the sandbox popup sometimes shows
"Things don't appear to be working" (one "Try again" fixes it), and in roughly 1 of 10 page loads the SDK opens
no window on click (a reload fixes it). Without LLM keys the agent falls back to a rule-based planner.
