// Merchant analytics on AG Studio: one dashboard over the store's own records (orders, order lines, the agent
// call journal, DisputeDesk cases). Loaded only when the Analytics tab is opened (the Studio bundle is ~5.5 MB
// raw, ~1.3 MB gzipped). The layout is a pre-built report in view mode; "Edit layout" switches Studio to its
// drag-and-drop editor so a merchant can build their own widgets on the same data.

const BRAND = "#2f6b4f";
let api = null;
let loading = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`${src} failed to load`));
    document.head.appendChild(s);
  });
}

const day = (iso) => (iso ? String(iso).slice(0, 10) : "");
const usd = (x) => Math.round(Number(x ?? 0) * 100) / 100;
const PAID = new Set(["COMPLETED", "REFUNDED", "PARTIALLY_REFUNDED"]);
const iface = (session) => (!session ? "Checkout page (human)" : session.startsWith("mcp_") ? "MCP server" : "WebMCP (in page)");

/** Plain rows for the Studio data engine. Exported for tests. */
export function buildSources({ orders, journal, cases, products }) {
  const cat = new Map((products ?? []).map((p) => [p.sku, p.category]));
  const orderRows = orders.map((o) => {
    const paid = PAID.has(o.status) || Boolean(o.captureId);
    const refunded = (o.refunds ?? []).reduce((s, r) => s + Number(r.amount ?? 0), 0);
    return {
      order_id: o.orderId,
      day: day(o.createdAt),
      channel: o.channel === "agent" ? "AI agent" : "Human",
      interface: o.channel === "agent" ? iface(o.session) : "Checkout page (human)",
      status: o.status,
      paid: paid ? "Paid" : "Not paid",
      paid_usd: paid ? usd(o.total) : 0,
      refunded_usd: usd(refunded),
      net_usd: paid ? usd(Number(o.total) - refunded) : 0,
      under_mandate: o.mandateId ? "Yes" : "No",
    };
  });
  const byId = new Map(orderRows.map((o) => [o.order_id, o]));
  const lineRows = orders.flatMap((o) =>
    (o.items ?? []).map((i) => ({
      order_id: o.orderId,
      sku: i.sku,
      product: i.name,
      category: cat.get(i.sku) ?? "other",
      quantity: Number(i.quantity),
      revenue_usd: byId.get(o.orderId)?.paid === "Paid" ? usd(Number(i.unitPrice) * Number(i.quantity)) : 0,
    })),
  );
  const callRows = journal.map((e) => ({
    day: day(e.ts),
    session: e.session,
    interface: iface(e.session),
    tool: e.tool,
    outcome: e.ok ? "Allowed" : "Refused",
    allowed: e.ok ? 1 : 0,
    refused: e.ok ? 0 : 1,
    ms: Number(e.ms ?? 0),
  }));
  const caseRows = cases.map((c) => ({
    case_id: c.caseId,
    order_id: c.orderId ?? "",
    source: c.source === "paypal" ? "PayPal dispute" : "Store claim",
    reason: c.reasonText ?? c.reason ?? "",
    status: c.status,
    advice: c.assessment?.recommendation ?? "",
    amount_usd: usd(c.amount),
    win_pct: Math.round((c.assessment?.winProbability ?? 0) * 100),
  }));
  return { orders: orderRows, lines: lineRows, calls: callRows, cases: caseRows };
}

const MONEY = { format: "currencyFormat", formatOptions: { format: new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }) } };
const INT = { format: "integerFormat" };
const TEXT = { format: "textFormat" };
const f = (id, name, kind = TEXT) => ({ id, name, ...kind });

/** Field names and formats (days stay text: ISO strings, no locale-dependent date parsing). */
const FIELDS = {
  orders: [f("order_id", "PayPal order"), f("day", "Day"), f("channel", "Channel"), f("interface", "Arrived via"), f("status", "PayPal status"), f("paid", "Paid?"), f("paid_usd", "Paid", MONEY), f("refunded_usd", "Refunded", MONEY), f("net_usd", "Net", MONEY), f("under_mandate", "Under a mandate")],
  lines: [f("order_id", "PayPal order"), f("sku", "SKU"), f("product", "Product"), f("category", "Category"), f("quantity", "Quantity", INT), f("revenue_usd", "Paid revenue", MONEY)],
  calls: [f("day", "Day"), f("session", "Agent session"), f("interface", "Interface"), f("tool", "Tool"), f("outcome", "Outcome"), f("allowed", "Allowed", INT), f("refused", "Refused", INT), f("ms", "Server ms", INT)],
  cases: [f("case_id", "Case"), f("order_id", "PayPal order"), f("source", "Source"), f("reason", "Reason"), f("status", "Status"), f("advice", "DisputeDesk advice"), f("amount_usd", "Amount", MONEY), f("win_pct", "Win estimate, %", INT)],
};

export function dataDefinition(rows) {
  return {
    sources: Object.keys(FIELDS).map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1), data: rows[id], fields: FIELDS[id] })),
    relationships: [
      { id: "lines-orders", source: { tableId: "lines", fieldId: "order_id" }, target: { tableId: "orders", fieldId: "order_id" }, type: "many-to-one" },
      { id: "cases-orders", source: { tableId: "cases", fieldId: "order_id" }, target: { tableId: "orders", fieldId: "order_id" }, type: "many-to-one" },
    ],
  };
}

const title = (text) => ({ title: { enabled: true, text } });
const legend = { style: { theme: { common: { legend: { enabled: true, position: "bottom" } } } } };

/** The pre-built report: what a merchant asks first about agent traffic. Exported for tests. */
export function reportState() {
  const w = {
    intro: {
      type: "text",
      dataMapping: {},
      format: {
        ...title("Agent vs human commerce"),
        style: { text: "Every order, the agent calls behind it and the claims after it. Click a channel or a chart segment to cross-filter the page.", typography: { fontSize: 14 } },
      },
    },
    k_net: { type: "value", dataMapping: { value: [{ id: "orders.net_usd", aggregation: "sum" }] }, format: title("Net revenue") },
    k_orders: { type: "value", dataMapping: { value: [{ id: "orders.order_id", aggregation: "count" }] }, format: title("Orders") },
    k_calls: { type: "value", dataMapping: { value: [{ id: "calls.allowed", aggregation: "sum" }] }, format: title("Agent calls") },
    k_refused: { type: "value", dataMapping: { value: [{ id: "calls.refused", aggregation: "sum" }] }, format: title("Refused calls") },
    f_channel: { type: "button-filter", dataMapping: { value: [{ id: "orders.channel" }] }, format: title("Channel") },
    f_iface: { type: "button-filter", dataMapping: { value: [{ id: "orders.interface" }] }, format: title("How the order arrived") },
    rev_channel: {
      type: "donut-chart",
      dataMapping: { categoryKey: [{ id: "orders.channel" }], valueKey: [{ id: "orders.paid_usd", aggregation: "sum" }], tooltipKey: [] },
      format: title("Paid revenue by channel"),
    },
    rev_category: {
      type: "column-chart-grouped",
      dataMapping: { categoryKey: [{ id: "lines.category" }], valueKey: [{ id: "lines.revenue_usd", aggregation: "sum" }], tooltipKey: [] },
      format: title("Paid revenue by category, USD"),
    },
    tools: {
      type: "bar-chart-stacked",
      dataMapping: { categoryKey: [{ id: "calls.tool" }], valueKey: [{ id: "calls.allowed", aggregation: "sum" }, { id: "calls.refused", aggregation: "sum" }], tooltipKey: [] },
      format: { ...title("Agent tool calls: allowed vs refused"), ...legend },
    },
    cases: {
      type: "column-chart-stacked",
      dataMapping: { categoryKey: [{ id: "cases.advice" }], valueKey: [{ id: "cases.amount_usd", aggregation: "sum" }], tooltipKey: [] },
      format: title("Claim value by DisputeDesk advice"),
    },
    grid: {
      type: "grid",
      dataMapping: {
        cols: [{ id: "orders.day" }, { id: "orders.order_id" }, { id: "orders.channel" }, { id: "orders.interface" }, { id: "orders.status" }, { id: "orders.paid_usd", aggregation: "sum" }, { id: "orders.refunded_usd", aggregation: "sum" }],
      },
      format: title("Orders"),
    },
  };
  const L = (x, y, xs, ys) => ({ xTrack: x, yTrack: y, xSpan: xs, ySpan: ys });
  const layout = {
    intro: L(0, 0, 8, 7),
    k_net: L(8, 0, 4, 7),
    k_orders: L(12, 0, 4, 7),
    k_calls: L(16, 0, 4, 7),
    k_refused: L(20, 0, 4, 7),
    f_channel: L(0, 7, 8, 8),
    f_iface: L(8, 7, 16, 8),
    rev_channel: L(0, 15, 8, 16),
    rev_category: L(8, 15, 8, 16),
    tools: L(16, 15, 8, 16),
    grid: L(0, 31, 16, 18),
    cases: L(16, 31, 8, 18),
  };
  return {
    pages: [{ id: "agentic", widgets: w, widgetLayout: layout }],
    selectedPageId: "agentic",
    panels: { filters: { collapsed: true }, data: { collapsed: true }, edit: { collapsed: true } },
  };
}

/** Load Studio once and render (or refresh the data of) the dashboard. */
export async function showAnalytics(el, fetchAll, cfg) {
  const rows = buildSources(await fetchAll());
  if (api) {
    api.setProperty("data", dataDefinition(rows));
    return api;
  }
  loading ??= loadScript("/vendor/ag-studio.js").then(() => {
    const S = window.agStudio;
    if (!S?.createStudio) throw new Error("AG Studio did not load");
    if (cfg?.agStudioLicense) S.AgStudioLicenseManager.setLicenseKey(cfg.agStudioLicense);
    const theme = S.studioTheme?.withParams?.({ accentColor: BRAND, fontFamily: "inherit" });
    api = S.createStudio(el, {
      mode: "view",
      initialState: reportState(),
      data: dataDefinition(rows),
      ...(theme ? { theme } : {}),
      onErrorRaised: (e) => console.warn("AG Studio:", e?.message ?? e),
    });
    return api;
  });
  return loading;
}

export function toggleEdit() {
  if (!api) return null;
  const mode = api.getProperty("mode") === "edit" ? "view" : "edit";
  api.setProperty("mode", mode);
  return mode;
}
