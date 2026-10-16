# paypal-agent-store (Leafline)

Status: **prototype**, PayPal **sandbox only**, not audited. Not a product.

An agent-ready storefront: a small tea shop on PayPal Orders v2 that lets AI agents shop for a buyer inside a
spending mandate the buyer sets, while every payment is still approved by the buyer in PayPal.

- Six agent tools — `search_products`, `get_budget`, `create_order`, `get_order_status`, `request_refund`,
  `open_dispute` — defined once (`web/webmcp.js`) and offered two ways:
  - **WebMCP** in the page (`document.modelContext`), used by the in-page agent and browser agents;
  - **MCP** for external agents: stdio (`src/mcp-stdio.ts`) and Streamable HTTP at `POST /mcp` (`src/mcp.ts`).
- **Spending mandates** (budget, per-order cap, categories, expiry, revoke) are enforced by the store server on
  every agent order, before a PayPal order exists; refusals come back as `OVER_BUDGET`, `OVER_PER_ORDER`,
  `CATEGORY_NOT_ALLOWED`, `EXPIRED`, `REVOKED`, `NOT_FOUND`.
- **Agent receipt**: every agent tool call is journaled per session and linked to the order it produced.
- **Merchant side on the PayPal Agent Toolkit** (`@paypal/agent-toolkit` 1.11.0, `src/toolkit.ts`): order status
  (`get_order`), PayPal disputes (`list_disputes`, `get_dispute`, `accept_dispute_claim`), refunds
  (`create_refund`, `get_refund`). Post-purchase claims go to a DisputeDesk module that cites the agent journal
  as evidence; the merchant refunds or accepts the dispute from the panel (AG Grid Community).

## Run

```sh
npm install
npm test                                              # unit + HTTP + MCP-client tests, no network
scripts/with-sandbox-env.sh node src/server.ts        # http://localhost:8787 (store, /order, /merchant, /mcp)
scripts/with-sandbox-env.sh node scripts/toolkit_smoke.ts             # live Toolkit check (read-only)
scripts/with-sandbox-env.sh python scripts/e2e_browser.py --flags     # full browser E2E against the running store
```

Connect an external agent (the buyer first delegates a budget on the store page and copies the mandate id):

```sh
# Streamable HTTP
npx @modelcontextprotocol/inspector --cli http://localhost:8787/mcp --header "X-Agent-Mandate: md_..." --method tools/list
# stdio (e.g. Claude Desktop / Claude Code config: command node, args [src/mcp-stdio.ts])
STORE_URL=http://localhost:8787 STORE_MANDATE=md_... node src/mcp-stdio.ts
# minimal SDK client used by the E2E
node scripts/mcp_client.ts --url http://localhost:8787 --mandate md_... call create_order '{"items":[{"sku":"TEA-SENCHA-80","quantity":1}]}'
```

## Threat model (what is and is not enforced)

- **An agent is identified by its own headers.** WebMCP tools and the MCP server send `X-Agent-Tool`,
  `X-Agent-Session` and (when delegated) `X-Agent-Mandate`. A request with only some of them is refused (400). An
  agent that sends none of them is indistinguishable from a human visitor: it gets no mandate, no journal, and
  the human checkout. The store cannot prove who is calling; mandates bound well-behaved agents and anything
  that holds a mandate id.
- **Every charge is approved by the buyer.** An agent can create an order but cannot pay: the buyer approves
  in PayPal (popup or `approveUrl`), and only the merchant server captures. That approval, not the headers, is
  the real limit on money leaving the buyer.
- **A mandate id is a bearer capability** (`md_` + 64 random bits) for spending up to its limits. Whoever has it
  can create orders inside it; each still needs buyer approval. The buyer can revoke it at any time.
- **Prices come from the server catalog**; agents send only `sku` + `quantity`.
- **Merchant actions** (refund, decline, accept dispute) refuse agent headers and require `X-Merchant-Key` when
  `MERCHANT_KEY` is set. Merchant read endpoints are open in this demo.
- **PayPal Agent Toolkit 1.11.0 guards** (found in its source): `run()` / `handleToolCall` execute any tool name
  regardless of the configured actions, so the server enforces its own allow-list of six tools before `run()`;
  the Toolkit caches its OAuth token forever, so we pass our own refreshed token; refund idempotency needs a
  per-call `request_id` (PayPal-Request-Id), so each refund gets its own Toolkit instance; Toolkit errors come
  back as JSON strings and are turned into exceptions. Order creation and capture stay on our own Orders v2
  client because the Toolkit's `create_order` has no `custom_id` / item `sku` (the order could not carry the
  agent session and mandate) and its `pay_order` sends no PayPal-Request-Id.
- **Sandbox is enforced in code** (`assertSandbox`, Toolkit host check); credentials come from env only.
- **Known dependency advisories**: `npm audit` reports transitive issues through the Toolkit's dependencies
  (`@langchain/core`, `ai`, `mathjs`, `jsondiffpatch`, `uuid`). We import only `@paypal/agent-toolkit/mcp` and
  never pass buyer or agent input to the Toolkit's order builder (the `mathjs` path).

## Verified

- Unit, HTTP and MCP-client tests: **64/64** (`npm test`), including the official MCP SDK client over Streamable
  HTTP and over stdio (child process): order inside the mandate; over-budget, per-order, category, revoked and
  no-mandate refusals.
- Live sandbox, 16.10.2026, Chrome 155 with the WebMCP flag, `scripts/e2e_browser.py`: **15/15**, twice — human
  checkout through the JS SDK v6 popup; in-page agent (run 1: Gemini planner; run 2: the free-tier LLM was
  unavailable and the rule-based planner took over, as designed) orders via WebMCP inside a 40 USD mandate,
  buyer approves, COMPLETED; over-budget refused; claim -> DisputeDesk case with agent evidence -> refund through
  the Toolkit's `create_refund` (COMPLETED); external MCP agent orders via `/mcp` inside a 20 USD mandate, buyer
  approves the `approveUrl` in PayPal, COMPLETED; its over-budget order refused (`OVER_BUDGET`).
- MCP Inspector CLI 2.11.0 (independent client) against `/mcp`: `tools/list` returns the six tools,
  `create_order` creates a sandbox PayPal order inside a 12 USD mandate, the second one is refused `OVER_BUDGET`.
- Known sandbox flakiness, handled and printed as `NOTE` by the E2E script, never hidden: the popup sometimes shows
  "Things don't appear to be working" (one "Try again" fixes it), and about 1 in 10 page loads the SDK opens no
  window on click (a reload fixes it). Accounts created with country BY could not complete payments; US sandbox
  accounts are used.

WebMCP (verified 2026-10-16, Chrome 155): native API is `document.modelContext` and only exists with
`--enable-features=WebMCP,WebMCPTesting` (chrome://flags/#enable-webmcp-testing). Without the flag the
MCP-B polyfill (`@mcp-b/global`, MIT) provides the same surface.

## Reviews

Independent code review by Google Jules (sessions 1877010590083434047, 11669279245805133758). Taken: fail-closed
agent detection, single in-flight capture per order and refund per claim, server-side tool descriptions for the
LLM step, `tool_call_id` validation, key stripping in LLM error bodies, escaping in `notice()`, control-character
cleanup in evidence. Not taken: replacing journal snapshots in evidence with the current catalog (evidence must
show what the agent saw at the time).

License: MIT.
