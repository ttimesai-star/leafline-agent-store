// The merchant dashboard is agent-readable too: AG Studio's own AI tools (Studio Agent Framework, AI module)
// are published over WebMCP, so an agent in the merchant's browser can ask the dashboard questions
// ("how many agent calls were refused, by tool?") instead of scraping charts.
// Read-only slice only (view_schema, view_page, view_widget, execute_query), as AG's WebMCP guide recommends:
// the mutating Studio tools are not exposed. Names get a dashboard_ prefix so they never collide with the
// store's buyer-side tools (those live on the storefront page).
import { findModelContext, registerStoreTools } from "./webmcp.js";

const text = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj) }] });

function isObjectRoot(schema) {
  return schema && schema.type === "object" && !schema.anyOf && !schema.oneOf;
}

/** Wrap Studio AgAiTool instances as WebMCP tool descriptors. Exported for tests. */
export function toWebMcpTools(studioTools) {
  const out = [];
  for (const tool of studioTools) {
    const sch = tool?.schema?.();
    if (!sch || typeof tool.execute !== "function") continue;
    // Several LLM providers reject a parameters root that is anyOf (execute_query's union): nest it under "query".
    const wrapped = !isObjectRoot(sch.parameters);
    const inputSchema = wrapped
      ? { type: "object", properties: { query: sch.parameters }, required: ["query"], additionalProperties: false }
      : sch.parameters;
    out.push({
      name: `dashboard_${sch.name}`,
      description: `Merchant dashboard (AG Studio, read-only): ${sch.description}`,
      inputSchema,
      annotations: { readOnlyHint: true },
      async execute(args = {}) {
        const ctl = new AbortController();
        const ctx = {
          signal: ctl.signal,
          run: { threadId: "webmcp", runId: globalThis.crypto?.randomUUID?.() ?? String(Date.now()) },
          success: (response, data) => ({ success: true, response, data }),
          error: (messages) => ({ success: false, issues: [].concat(messages).map((message) => ({ message })) }),
        };
        try {
          const r = await tool.execute({ toolCallId: ctx.run.runId, name: sch.name, args: wrapped ? args.query ?? {} : args }, ctx);
          if (r?.success) return text({ response: r.response, data: r.data ?? null });
          return { ...text({ error: (r?.issues ?? []).map((i) => i.message).join("; ") || "tool failed" }), isError: true };
        } catch (e) {
          return { ...text({ error: String(e?.message ?? e).slice(0, 300) }), isError: true };
        }
      },
    });
  }
  return out;
}

/** Register the dashboard tools with the browser's WebMCP context (if any). Returns what was advertised. */
export async function publishDashboardTools(studioApi) {
  const t = studioApi.getAiTools();
  const tools = toWebMcpTools([t.viewSchema(), t.viewPage(), t.viewWidget(), t.executeQuery()]);
  globalThis.__dashboardTools = tools; // for the E2E check and the page's own status line
  const res = await registerStoreTools(findModelContext(), tools);
  return { ...res, tools: tools.map((x) => x.name) };
}

/** The question the panel's "Ask the dashboard" button sends: allowed vs refused agent calls by tool. */
export const SAMPLE_QUERY = {
  query: {
    variant: "aggregation",
    kind: "apiQuery",
    axes: [{ dimensions: [{ field: { id: "calls.tool" }, as: "tool" }] }],
    measures: [
      { field: { id: "calls.allowed", aggregation: "sum" }, as: "allowed" },
      { field: { id: "calls.refused", aggregation: "sum" }, as: "refused" },
    ],
  },
};

/**
 * Run dashboard_execute_query the way an external browser agent would: through document.modelContext.executeTool
 * when the browser has WebMCP, otherwise through the same tool object. Returns { via, rows }.
 */
export async function askDashboard(args = SAMPLE_QUERY) {
  const mc = findModelContext();
  let raw;
  let via;
  if (mc && typeof mc.executeTool === "function" && typeof mc.getTools === "function") {
    const t = (await mc.getTools()).find((x) => x.name === "dashboard_execute_query");
    if (!t) throw new Error("dashboard_execute_query is not registered");
    raw = await mc.executeTool(t, args);
    via = "document.modelContext.executeTool (WebMCP)";
  } else {
    const t = (globalThis.__dashboardTools ?? []).find((x) => x.name === "dashboard_execute_query");
    if (!t) throw new Error("dashboard tools are not ready");
    raw = await t.execute(args);
    via = "the same tool object (this browser has no WebMCP)";
  }
  const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
  let payload = {};
  try {
    payload = JSON.parse(obj?.content?.[0]?.text ?? "{}");
  } catch {
    payload = {};
  }
  if (obj?.isError || payload?.error) throw new Error(payload?.error ?? "query failed");
  return { via, rows: payload?.data?.result ?? [] };
}
