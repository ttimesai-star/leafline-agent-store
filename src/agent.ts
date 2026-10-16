// Server half of the in-page demo shopping agent. The agent loop runs in the buyer's browser and executes
// tools through WebMCP (document.modelContext); this endpoint only asks the LLM for the next step. Keys stay
// on the server, the system prompt is fixed here (the client cannot replace it), and only the store's own
// tool names are accepted. When no LLM key is configured the browser falls back to a rule-based planner.
import type { ChatMessage, Llm, ToolCall, ToolSpec } from "./llm.ts";

export const AGENT_TOOL_NAMES = ["search_products", "get_budget", "create_order", "get_order_status", "request_refund", "open_dispute"] as const;

export const SYSTEM_PROMPT = [
  "You are a shopping agent acting for one human buyer on an online tea and coffee store (PayPal sandbox demo).",
  "You can only act through the provided tools. Rules:",
  "1. Call get_budget first: the buyer gave you a spending mandate (budget, optional per-order max, allowed categories, expiry). Never try to exceed it; the store enforces it anyway and will refuse.",
  "2. Use search_products to find items that match the buyer's request; prefer the cheapest items that satisfy it. Use exact sku values from search results.",
  "3. Call create_order once with the chosen items. You cannot pay: the buyer approves the payment in PayPal. After create_order, stop calling tools and tell the buyer the order id, the total and that they need to approve it with the PayPal button.",
  "4. Use request_refund or open_dispute only when the buyer explicitly asks for it, and only for a paid order.",
  "5. If a tool returns an error, explain it plainly to the buyer; do not retry the same call more than once.",
  "Keep the final answer under 80 words.",
].join("\n");

const MAX_MESSAGES = 40;
const MAX_CONTENT = 4000;

export interface StepInput {
  messages: ChatMessage[];
  tools: ToolSpec[];
}

function str(v: unknown, max = MAX_CONTENT): string {
  return String(v ?? "").slice(0, max);
}

/** Validate the browser's conversation. Throws on anything outside the expected shape. */
export function validateStep(body: any): StepInput {
  const msgs = body?.messages;
  if (!Array.isArray(msgs) || msgs.length === 0 || msgs.length > MAX_MESSAGES) throw new Error(`messages must be an array of 1..${MAX_MESSAGES}`);
  const messages: ChatMessage[] = msgs.map((m: any) => {
    if (m?.role === "user") return { role: "user", content: str(m.content) };
    if (m?.role === "assistant") {
      const calls: ToolCall[] = Array.isArray(m.tool_calls)
        ? m.tool_calls.slice(0, 4).map((c: any) => {
            const name = str(c?.function?.name, 40);
            if (!(AGENT_TOOL_NAMES as readonly string[]).includes(name)) throw new Error(`unknown tool in history: ${name}`);
            const sig = c?.extra_content?.google?.thought_signature;
            return {
              id: str(c?.id, 80),
              type: "function" as const,
              function: { name, arguments: str(c?.function?.arguments, 2000) },
              ...(typeof sig === "string" && sig.length <= 16_000 ? { extra_content: { google: { thought_signature: sig } } } : {}),
            };
          })
        : [];
      return calls.length ? { role: "assistant", content: m.content == null ? null : str(m.content), tool_calls: calls } : { role: "assistant", content: str(m.content) };
    }
    if (m?.role === "tool") return { role: "tool", tool_call_id: str(m.tool_call_id, 80), content: str(m.content) };
    throw new Error("message role must be user, assistant or tool");
  });
  if (messages[0].role !== "user") throw new Error("conversation must start with the buyer's request");
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const specs: ToolSpec[] = tools.slice(0, 10).map((t: any) => {
    const name = str(t?.name, 40);
    if (!(AGENT_TOOL_NAMES as readonly string[]).includes(name)) throw new Error(`unknown tool: ${name}`);
    const params = t?.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object", properties: {} };
    if (JSON.stringify(params).length > 3000) throw new Error("tool schema too large");
    return { type: "function", function: { name, description: str(t?.description, 600), parameters: params } };
  });
  if (!specs.length) throw new Error("no tools: the page must expose its WebMCP tools");
  return { messages, tools: specs };
}

export async function agentStep(llm: Llm, input: StepInput) {
  const r = await llm.chat([{ role: "system", content: SYSTEM_PROMPT }, ...input.messages], input.tools);
  const toolCalls = r.toolCalls
    .filter((c) => (AGENT_TOOL_NAMES as readonly string[]).includes(c.function?.name))
    .slice(0, 3)
    .map((c, i) => ({ id: c.id || `call_${Date.now()}_${i}`, name: c.function.name, arguments: c.function.arguments || "{}", ...(c.extra_content ? { extra_content: c.extra_content } : {}) }));
  return { content: r.content, toolCalls, provider: r.provider, model: r.model };
}
