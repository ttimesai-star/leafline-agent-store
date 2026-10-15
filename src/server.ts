// HTTP server: storefront page, JSON API used both by humans (page buttons) and by AI agents (WebMCP tools
// call the same API with X-Agent-Tool / X-Agent-Session headers, which get journaled).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { searchProducts, priceOrder } from "./catalog.ts";
import { AgentJournal, validSession } from "./journal.ts";
import { PayPalClient, PayPalError, configFromEnv, approveLink, assertOrderId } from "./paypal.ts";

export interface PaymentsPort {
  createOrder: PayPalClient["createOrder"];
  getOrder: PayPalClient["getOrder"];
  captureOrder: PayPalClient["captureOrder"];
}

export interface AppDeps {
  payments: PaymentsPort;
  journal: AgentJournal;
  baseUrl: string;
  webDir?: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const STATIC: Record<string, string> = {
  "/": "index.html",
  "/index.html": "index.html",
  "/store.js": "store.js",
  "/webmcp.js": "webmcp.js",
};
const MIME: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8" };
const MAX_BODY = 16 * 1024;

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw Object.assign(new Error("body too large"), { http: 413 });
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid JSON"), { http: 400 });
  }
}

function orderView(o: any) {
  const pu = o?.purchase_units?.[0];
  const cap = pu?.payments?.captures?.[0];
  return {
    orderId: o?.id,
    status: o?.status,
    amount: pu?.amount ? `${pu.amount.value} ${pu.amount.currency_code}` : undefined,
    captureId: cap?.id,
    captureStatus: cap?.status,
  };
}

export function createHandler(deps: AppDeps) {
  const webDir = deps.webDir ?? join(HERE, "..", "web");
  return async function handler(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const agentTool = req.headers["x-agent-tool"];
    const agentSession = req.headers["x-agent-session"];
    const isAgent = typeof agentTool === "string" && validSession(agentSession);
    const started = Date.now();
    let toolArgs: unknown = Object.fromEntries(url.searchParams);
    const journal = (ok: boolean, summary: string, orderId?: string) => {
      if (!isAgent) return;
      deps.journal.record({ session: agentSession as string, tool: String(agentTool).slice(0, 40), args: toolArgs, ok, summary, orderId, ms: Date.now() - started });
    };

    try {
      if (req.method === "GET" && STATIC[path]) {
        const file = STATIC[path];
        res.writeHead(200, { "content-type": MIME[file.split(".").pop()!], "cache-control": "no-store" });
        res.end(readFileSync(join(webDir, file)));
        return;
      }

      if (req.method === "GET" && path === "/api/products") {
        const maxPrice = url.searchParams.has("max_price") ? Number(url.searchParams.get("max_price")) : undefined;
        const items = searchProducts(url.searchParams.get("q") ?? "", { maxPrice: Number.isFinite(maxPrice) ? maxPrice : undefined, limit: Number(url.searchParams.get("limit") ?? 5) });
        journal(true, `${items.length} result(s)`);
        return send(res, 200, { currency: "USD", items });
      }

      if (req.method === "POST" && path === "/api/orders") {
        const body = await readJson(req);
        toolArgs = body;
        const priced = priceOrder(body?.items);
        const order = await deps.payments.createOrder({
          currency: priced.currency,
          total: priced.total,
          items: priced.items,
          referenceId: "store",
          customId: isAgent ? `agent:${agentSession}` : "human",
          returnUrl: `${deps.baseUrl}/paypal/return`,
          cancelUrl: `${deps.baseUrl}/paypal/cancel`,
        }, randomUUID());
        const view = { ...orderView(order), total: `${priced.total} ${priced.currency}`, approveUrl: approveLink(order), next: "The buyer must approve this payment in PayPal (approveUrl). The agent cannot approve on the buyer's behalf." };
        journal(true, `order ${order.id} ${priced.total} ${priced.currency}`, order.id);
        return send(res, 201, view);
      }

      const m = path.match(/^\/api\/orders\/([^/]+)(\/capture|\/agent-log)?$/);
      if (m) {
        const id = assertOrderId(decodeURIComponent(m[1]));
        toolArgs = { orderId: id };
        if (req.method === "GET" && !m[2]) {
          const v = orderView(await deps.payments.getOrder(id));
          journal(true, `status ${v.status}`, id);
          return send(res, 200, v);
        }
        if (req.method === "POST" && m[2] === "/capture") {
          if (isAgent) {
            journal(false, "capture refused for agents", id);
            return send(res, 403, { error: "capture is merchant-side only" });
          }
          const v = orderView(await deps.payments.captureOrder(id, `cap-${id}`));
          return send(res, 200, v);
        }
        if (req.method === "GET" && m[2] === "/agent-log") return send(res, 200, deps.journal.receipt(id));
      }

      if (req.method === "GET" && path === "/paypal/return") {
        const id = assertOrderId(url.searchParams.get("token") ?? "");
        const v = orderView(await deps.payments.captureOrder(id, `cap-${id}`));
        res.writeHead(302, { location: `/?order=${encodeURIComponent(id)}&status=${encodeURIComponent(String(v.status))}` });
        res.end();
        return;
      }
      if (req.method === "GET" && path === "/api/journal/stats") return send(res, 200, deps.journal.stats());

      return send(res, 404, { error: "not found" });
    } catch (e: any) {
      const status = e?.http ?? (e instanceof PayPalError ? (e.status >= 400 && e.status < 500 ? 422 : 502) : 400);
      const msg = e instanceof PayPalError ? `payment provider error${e.issue ? ": " + e.issue : ""}` : String(e?.message ?? "error").slice(0, 200);
      journal(false, msg);
      return send(res, status, { error: msg, debugId: e instanceof PayPalError ? e.debugId : undefined });
    }
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 8787);
  const payments = new PayPalClient(configFromEnv());
  const journal = new AgentJournal(join(HERE, "..", "data", "agent_journal.jsonl"));
  createServer(createHandler({ payments, journal, baseUrl: `http://localhost:${port}` })).listen(port, "127.0.0.1", () => {
    console.log(`agent store on http://localhost:${port} (PayPal sandbox)`);
  });
}
