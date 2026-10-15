// WebMCP tools for the storefront. Works with the native Chrome API (navigator.modelContext,
// behind chrome://flags/#enable-webmcp-testing) and with the MCP-B polyfill (document/navigator.modelContext).
// Each tool calls the same JSON API as the human UI, tagged with X-Agent-Tool / X-Agent-Session headers.

export function makeSessionId() {
  const a = new Uint8Array(12);
  globalThis.crypto.getRandomValues(a);
  return "ag_" + Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

const text = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });

export function buildStoreTools({ fetchImpl = globalThis.fetch, base = "", session = makeSessionId() } = {}) {
  async function api(tool, method, path, body) {
    const res = await fetchImpl(base + path, {
      method,
      headers: { "content-type": "application/json", "x-agent-tool": tool, "x-agent-session": session },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { isError: true, ...text({ error: data.error ?? `HTTP ${res.status}` }) };
    return text(data);
  }

  return [
    {
      name: "search_products",
      description: "Search the store catalog. Returns sku, name, price (USD) and stock. Use the sku in create_order.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keywords, e.g. 'green tea' or 'kettle'" },
          max_price: { type: "number", description: "Optional max unit price in USD" },
        },
        required: ["query"],
      },
      annotations: { readOnlyHint: true },
      async execute({ query, max_price } = {}) {
        const q = new URLSearchParams({ q: String(query ?? "") });
        if (max_price !== undefined) q.set("max_price", String(max_price));
        return api("search_products", "GET", `/api/products?${q}`);
      },
    },
    {
      name: "create_order",
      description:
        "Create a PayPal order for the given items. Prices are set by the store. Returns approveUrl: the human buyer must open it and approve the payment in PayPal; the agent cannot pay by itself.",
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
      async execute({ items } = {}) {
        return api("create_order", "POST", "/api/orders", { items });
      },
    },
    {
      name: "get_order_status",
      description: "Get the PayPal status of an order created by create_order (CREATED, PAYER_ACTION_REQUIRED, APPROVED, COMPLETED).",
      inputSchema: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
      annotations: { readOnlyHint: true },
      async execute({ order_id } = {}) {
        return api("get_order_status", "GET", `/api/orders/${encodeURIComponent(String(order_id ?? ""))}`);
      },
    },
  ];
}

/** Find a WebMCP context object: native Chrome first, then polyfill locations. */
export function findModelContext(g = globalThis) {
  return g.navigator?.modelContext ?? g.document?.modelContext ?? null;
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
