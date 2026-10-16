# paypal-agent-store (Leafline)

Status: **prototype**, PayPal **sandbox only**, not audited. Not a product.

Live demo (sandbox): **https://leafline-agent-store.onrender.com** - store `/`, merchant panel `/merchant`, MCP
endpoint `POST /mcp`. Free Render instance: the first request after ~15 idle minutes takes up to a minute, and the
order book resets to the seeded sandbox orders on every restart.

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
  as evidence; the merchant refunds or accepts the dispute from the panel (AG Grid Community tables).
- **Merchant analytics on AG Studio 3.0** (`web/analytics.js`): a pre-built report over the store's own records
  (orders, order lines, agent call journal, DisputeDesk cases, joined by order id) - agent vs human revenue,
  refused agent calls by tool, claim value by DisputeDesk advice - with cross-filtering and an "Edit layout" switch
  to Studio's drag-and-drop editor.
- **The dashboard is agent-readable too** (`web/studio_webmcp.js`): AG Studio's AI module (Studio Agent
  Framework) tools `view_schema`, `view_page`, `view_widget`, `execute_query` are published over WebMCP as
  read-only `dashboard_*` tools, so an agent in the merchant's browser can query the analytics
  ("allowed vs refused agent calls by tool") instead of scraping charts. Mutating Studio tools are not exposed.

## Run

```sh
npm install
npm test                                              # unit + HTTP + MCP-client tests, no network
scripts/with-sandbox-env.sh node src/server.ts        # http://localhost:8787 (store, /order, /merchant, /mcp)
scripts/with-sandbox-env.sh node scripts/toolkit_smoke.ts             # live Toolkit check (read-only)
scripts/with-sandbox-env.sh python scripts/e2e_browser.py --flags     # full browser E2E against the running store
node scripts/reset_demo_data.ts [--apply] [--wipe] [--export-seed demo/seed]   # clean test orders (store stopped)
python scripts/render_deploy.py                       # deploy the public demo, check live version == HEAD
```

Environment (all optional except the PayPal pair): `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` (sandbox app),
`MERCHANT_KEY` (signs merchant actions), `PUBLIC_MERCHANT_VIEW=1` (demo: panel readable without the key),
`AG_STUDIO_LICENSE_KEY` (AG Studio trial key; without it Studio shows a watermark), `GEMINI_API_KEY` (one or
more comma-separated keys), `MISTRAL_API_KEY`, `DATA_DIR`, `DEMO_SEED_DIR`, `LLM_STEPS_PER_10MIN`,
`WRITES_PER_10MIN`. `scripts/with-sandbox-env.sh` fills them from a secrets file outside the repo.

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
  `MERCHANT_KEY` is set (constant-time check). Merchant views (all buyers' orders, journal, cases, Toolkit log)
  refuse agent headers and also need the key, except on the public demo (`PUBLIC_MERCHANT_VIEW=1`), where they
  are readable so the panel can be judged - all data there is sandbox data with masked payer emails. The panel
  takes the key from a `#key=` URL fragment (never sent to the server) or a form, keeps it in `sessionStorage`.
- **Dashboard WebMCP tools are read-only** (`readOnlyHint`) and see only what the panel shows. Any agent the
  merchant runs in that browser tab can read the analytics; none can change the report or touch money.
- **Rate limits behind the proxy**: the client IP comes from `CF-Connecting-IP` (Render is behind Cloudflare)
  before the client-controlled `X-Forwarded-For`; on top of per-IP limits there are whole-server ceilings for LLM
  steps and writes, so spoofed IPs cannot burn the free LLM quotas or flood the sandbox.
- **AG Studio licence key** is a front-end key by design (it ends up in the page); it is injected from env via
  `/api/config` and never committed. The trial keys expire on 12.11.2026 (Grid/Charts) and 16.11.2026 (Studio);
  after that the live demo shows AG's watermark until a new key is set.
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

- 16.10.2026, public Render deployment (version checked against the commit), Chrome 155 with the WebMCP flag:
  `scripts/e2e_browser.py --url https://leafline-agent-store.onrender.com --flags` **18/18**, twice - the 15 steps
  below plus the AG Studio dashboard: licensed render, four `dashboard_*` tools registered in native WebMCP, and
  `dashboard_execute_query` answering allowed vs refused agent calls by tool. Second run with the LLM planner
  (Gemini 3 Flash); the first fell back to rules (free-tier quota), which led to the multi-key chain.
- Merchant key on: the same claims flow with `MERCHANT_KEY` set passes 8/8 (panel sends `X-Merchant-Key`).
- Unit, HTTP and MCP-client tests: **84/84** (`npm test`), including the official MCP SDK client over Streamable
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

Independent code review by Google Jules (sessions 1877010590083434047, 11669279245805133758, 4709167192530215068,
1039657886568469323). From 1039657886568469323, all taken: the rate limiter no longer clears every key when it
passes 10 000 entries (that let a flood of spoofed IPs reset blocked clients), LLM error bodies are masked for
every provider key, `/api/journal/stats` is a merchant view, atomic journal writes with a Windows-safe rename
fallback, the seed never overwrites an existing journal, `--export-seed` only with `--apply`.
Second reviewer from another vendor (Kimi K2.6, Moonshot) on the security-relevant diff: taken - env limits are
parsed so a typo cannot turn a global ceiling off (`n <= NaN` is always false), overlapping provider keys are
masked longest first; not taken - "hashing in keyMatches leaks the key length": the secret is hashed in the same
time on every request, and the suggested early length check would itself reveal the length (a 512-byte cap on
the header was added). Semgrep (p/javascript, p/typescript, p/nodejsscan, p/secrets): 8 warnings reviewed - six
regex-DoS hits are anchored, bounded character classes; the `innerHTML` hit escapes every value; the
`Math.random` run id became `crypto.randomUUID`. gitleaks over the full history: no leaks.

From 4709167192530215068, all taken: PayPal REST error bodies recognised as Toolkit errors, a refund without a
refund id is an error (claim stays open), `/mcp` transport closed once on every path, Toolkit log merchant-only.
Earlier, taken: fail-closed
agent detection, single in-flight capture per order and refund per claim, server-side tool descriptions for the
LLM step, `tool_call_id` validation, key stripping in LLM error bodies, escaping in `notice()`, control-character
cleanup in evidence. Not taken: replacing journal snapshots in evidence with the current catalog (evidence must
show what the agent saw at the time).

License: MIT.
