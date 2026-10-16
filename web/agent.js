// In-page demo shopping agent. It acts only through the store's WebMCP tools (callTool -> document.modelContext
// .executeTool), exactly like an external agent would. Two planners:
//  - LLM planner: the server's /api/agent/step asks an LLM (Gemini / Groq) for the next tool call;
//  - rule planner: deterministic fallback when no LLM is configured or the provider fails.
// Either way the server enforces the buyer's mandate; the agent cannot approve or capture a payment.

const STOP = new Set(["buy", "me", "a", "an", "the", "some", "for", "under", "below", "max", "please", "get", "order", "i", "want", "need", "and", "with", "of", "usd", "dollars", "budget", "within", "to", "my", "us"]);

/** Split "buy green tea and a mug under $40" into item phrases ["green tea", "mug"]. */
export function parseTask(task) {
  const t = String(task ?? "").toLowerCase().replace(/\$\s?\d+(\.\d+)?|\d+(\.\d+)?\s?(usd|dollars|\$)/g, " ");
  return t
    .split(/\band\b|,|\+|;|\bplus\b/)
    .map((part) => part.split(/[^a-z0-9-]+/).filter((w) => w && !STOP.has(w)).join(" "))
    .filter(Boolean)
    .slice(0, 5);
}

export async function runRuleAgent(task, { call, log }) {
  const budget = await call("get_budget", {});
  if (budget.isError) return { done: false, answer: budget.payload?.error ?? "no budget" };
  let remaining = Math.round(Number(budget.payload.remaining) * 100);
  const perOrder = budget.payload.perOrderMax ? Math.round(Number(budget.payload.perOrderMax) * 100) : Infinity;
  const allowed = budget.payload.categories;
  const phrases = parseTask(task);
  if (!phrases.length) return { done: false, answer: "I could not tell what to buy. Try: 'green tea and a mug'." };
  const picked = [];
  let total = 0;
  const skipped = [];
  for (const phrase of phrases) {
    const r = await call("search_products", { query: phrase });
    const items = (r.payload?.items ?? []).filter((p) => !allowed || allowed.includes(p.category));
    const cap = Math.min(remaining, perOrder) - total;
    const fits = items.filter((p) => Math.round(Number(p.price) * 100) <= cap).sort((a, b) => Number(a.price) - Number(b.price));
    if (!fits.length) {
      skipped.push(items.length ? `${phrase} (cheapest is ${items.map((p) => p.price).sort((a, b) => a - b)[0]} USD, over budget)` : `${phrase} (not found${allowed ? " in allowed categories" : ""})`);
      continue;
    }
    picked.push(fits[0]);
    total += Math.round(Number(fits[0].price) * 100);
    log?.(`picked ${fits[0].name} for "${phrase}" at ${fits[0].price} USD`);
  }
  if (!picked.length) return { done: false, answer: `Nothing fits the mandate: ${skipped.join("; ")}.` };
  const o = await call("create_order", { items: picked.map((p) => ({ sku: p.sku, quantity: 1 })) });
  if (o.isError) return { done: false, answer: `The store refused the order: ${o.payload?.error}` };
  remaining -= total;
  const note = skipped.length ? ` Skipped: ${skipped.join("; ")}.` : "";
  return {
    done: true,
    orderId: o.payload.orderId,
    answer: `Order ${o.payload.orderId} for ${o.payload.total}: ${picked.map((p) => p.name).join(", ")}. Please approve it with the PayPal button.${note}`,
  };
}

export async function runLlmAgent(task, { call, step, tools, log, maxSteps = 8 }) {
  const specs = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  const messages = [{ role: "user", content: String(task) }];
  let orderId = null;
  for (let i = 0; i < maxSteps; i++) {
    const r = await step({ messages, tools: specs });
    if (r.fallback) throw Object.assign(new Error(r.error ?? "LLM unavailable"), { fallback: true });
    if (!r.toolCalls?.length) return { done: Boolean(orderId), orderId, answer: r.content ?? "", provider: r.provider, model: r.model };
    messages.push({ role: "assistant", content: r.content ?? null, tool_calls: r.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) });
    for (const c of r.toolCalls) {
      let args = {};
      try {
        args = JSON.parse(c.arguments || "{}");
      } catch {
        args = {};
      }
      log?.(`LLM -> ${c.name}(${JSON.stringify(args)})`);
      const res = await call(c.name, args);
      if (c.name === "create_order" && !res.isError && res.payload?.orderId) orderId = res.payload.orderId;
      messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(res.isError ? { error: res.payload?.error ?? res.payload } : res.payload).slice(0, 3500) });
    }
  }
  return { done: Boolean(orderId), orderId, answer: orderId ? `Order ${orderId} created; please approve it with the PayPal button.` : "Stopped after the step limit." };
}
