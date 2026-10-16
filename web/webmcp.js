// WebMCP tools for the storefront.
// Verified 2026-10-16 on Chrome 155.0.8059.40 with --enable-features=WebMCP,WebMCPTesting
// (chrome://flags/#enable-webmcp-testing): the API is document.modelContext (navigator.modelContext is
// undefined) with registerTool / getTools / executeTool(registeredTool, argsObject) / when / ontoolchange;
// executeTool returns the tool result serialized as a JSON string. Without the flag the MCP-B polyfill
// (@mcp-b/global, loaded by the page) provides the same document.modelContext and also bridges the tools
// to external agents (MCP-B browser extension) over MCP.
// Each tool calls the same JSON API as the human UI, tagged with X-Agent-Tool / X-Agent-Session (and
// X-Agent-Mandate once the buyer delegated a budget), so the server journals and bounds every agent call.

export function makeSessionId() {
  const a = new Uint8Array(12);
  globalThis.crypto.getRandomValues(a);
  return "ag_" + Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

const text = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });

export const TOOL_NAMES = ["search_products", "get_budget", "create_order", "get_order_status", "request_refund", "open_dispute"];

export function buildStoreTools({ fetchImpl = globalThis.fetch, base = "", session = makeSessionId(), getMandate = () => null, onCall = null } = {}) {
  async function api(tool, method, path, body, args) {
    const started = Date.now();
    const headers = { "content-type": "application/json", "x-agent-tool": tool, "x-agent-session": session };
    const mandate = getMandate();
    if (mandate) headers["x-agent-mandate"] = mandate;
    let data = {};
    let ok = false;
    try {
      const res = await fetchImpl(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      data = await res.json().catch(() => ({}));
      ok = res.ok;
      if (!ok) data = { error: data.error ?? `HTTP ${res.status}`, code: data.code };
    } catch (e) {
      data = { error: `network error: ${e?.message ?? e}` };
    }
    try {
      onCall?.({ tool, args, ok, result: data, ms: Date.now() - started });
    } catch {
      // UI callbacks must never break a tool call.
    }
    return ok ? text(data) : { isError: true, ...text(data) };
  }

  const orderId = (v) => encodeURIComponent(String(v ?? ""));

  return [
    {
      name: "search_products",
      description: "Search the store catalog (tea, coffee, teaware, gift cards). Returns sku, name, price (USD), stock and category. Use the sku in create_order.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keywords, e.g. 'green tea', 'kettle', 'coffee beans'" },
          max_price: { type: "number", description: "Optional max unit price in USD" },
        },
        required: ["query"],
      },
      annotations: { readOnlyHint: true },
      async execute(args = {}) {
        const q = new URLSearchParams({ q: String(args.query ?? "") });
        if (args.max_price !== undefined && args.max_price !== null) q.set("max_price", String(args.max_price));
        return api("search_products", "GET", `/api/products?${q}`, undefined, args);
      },
    },
    {
      name: "get_budget",
      description: "Show the spending mandate the buyer delegated to you: budget, already spent, remaining, per-order max, allowed categories, expiry. Call this before ordering.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      async execute(args = {}) {
        const m = getMandate();
        if (!m) {
          const err = { error: "no spending mandate: ask the buyer to delegate a budget on the store page" };
          try { onCall?.({ tool: "get_budget", args, ok: false, result: err, ms: 0 }); } catch {}
          return { isError: true, ...text(err) };
        }
        return api("get_budget", "GET", `/api/mandates/${encodeURIComponent(m)}`, undefined, args);
      },
    },
    {
      name: "create_order",
      description:
        "Create a PayPal order for the given items within the buyer's mandate. Prices are set by the store. The buyer must approve the payment in PayPal (button on the page or approveUrl); you cannot pay by yourself.",
      inputSchema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: { sku: { type: "string" }, quantity: { type: "integer", minimum: 1, maximum: 10 } },
              required: ["sku", "quantity"],
            },
          },
        },
        required: ["items"],
      },
      async execute(args = {}) {
        return api("create_order", "POST", "/api/orders", { items: args.items }, args);
      },
    },
    {
      name: "get_order_status",
      description: "Get the PayPal status of an order (CREATED, PAYER_ACTION_REQUIRED, APPROVED, COMPLETED) plus refunds and claims.",
      inputSchema: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
      annotations: { readOnlyHint: true },
      async execute(args = {}) {
        return api("get_order_status", "GET", `/api/orders/${orderId(args.order_id)}`, undefined, args);
      },
    },
    {
      name: "request_refund",
      description: "Ask the merchant to refund a paid (COMPLETED) order you placed for the buyer. Only when the buyer asks for it. The merchant decides; refunds go back through PayPal.",
      inputSchema: {
        type: "object",
        properties: { order_id: { type: "string" }, note: { type: "string", description: "Why the buyer wants a refund" } },
        required: ["order_id", "note"],
      },
      async execute(args = {}) {
        return api("request_refund", "POST", `/api/orders/${orderId(args.order_id)}/claims`, { kind: "REFUND_REQUEST", reason: "OTHER", note: args.note }, args);
      },
    },
    {
      name: "open_dispute",
      description: "Open a dispute with the merchant about a paid order you placed (item not received, not as described, duplicate or incorrect charge). Only when the buyer asks for it.",
      inputSchema: {
        type: "object",
        properties: {
          order_id: { type: "string" },
          reason: {
            type: "string",
            enum: ["MERCHANDISE_OR_SERVICE_NOT_RECEIVED", "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", "DUPLICATE_TRANSACTION", "INCORRECT_AMOUNT", "OTHER"],
          },
          note: { type: "string" },
        },
        required: ["order_id", "reason", "note"],
      },
      async execute(args = {}) {
        return api("open_dispute", "POST", `/api/orders/${orderId(args.order_id)}/claims`, { kind: "DISPUTE", reason: args.reason, note: args.note }, args);
      },
    },
  ];
}

/** Find a WebMCP context object: document.modelContext (current spec, native Chrome and MCP-B), then navigator. */
export function findModelContext(g = globalThis) {
  return g.document?.modelContext ?? g.navigator?.modelContext ?? null;
}

/** Register tools with whichever API shape is available. Returns a description of what happened. */
export async function registerStoreTools(mc, tools) {
  if (!mc) return { ok: false, mode: "none", error: "WebMCP API not found (navigator.modelContext / document.modelContext undefined)" };
  try {
    if (typeof mc.registerTool === "function") {
      for (const t of tools) await mc.registerTool(t);
      return { ok: true, mode: "registerTool", tools: tools.map((t) => t.name) };
    }
    if (typeof mc.provideContext === "function") {
      await mc.provideContext({ tools });
      return { ok: true, mode: "provideContext", tools: tools.map((t) => t.name) };
    }
    return { ok: false, mode: "unknown", error: "modelContext has neither registerTool nor provideContext: " + Object.keys(Object.getPrototypeOf(mc) ?? {}).join(",") };
  } catch (e) {
    return { ok: false, mode: "error", error: `${e?.name ?? "Error"}: ${e?.message ?? e}` };
  }
}

/**
 * Call a registered tool through WebMCP itself (not the JS object), so the demo agent exercises the same path
 * an external agent uses. Falls back to the local tool object when the context has no executeTool.
 * Returns the parsed JSON payload plus isError.
 */
export async function callTool(mc, tools, name, args) {
  let raw;
  if (mc && typeof mc.executeTool === "function" && typeof mc.getTools === "function") {
    const registered = (await mc.getTools()).find((t) => t.name === name);
    if (!registered) throw new Error(`tool ${name} is not registered`);
    raw = await mc.executeTool(registered, args ?? {});
  } else {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`unknown tool ${name}`);
    raw = await t.execute(args ?? {});
  }
  const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
  let payload = null;
  try {
    payload = JSON.parse(obj?.content?.[0]?.text ?? "null");
  } catch {
    payload = obj?.content?.[0]?.text ?? null;
  }
  return { isError: Boolean(obj?.isError), payload };
}
