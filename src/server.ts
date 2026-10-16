// HTTP server: storefront, order page and merchant panel (static), plus one JSON API used by humans (page
// buttons, PayPal JS SDK v6) and by AI agents (WebMCP tools send X-Agent-Tool / X-Agent-Session /
// X-Agent-Mandate headers; every agent call is journaled).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname, resolve, sep } from "node:path";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { execSync } from "node:child_process";
import { searchProducts, priceOrder, findProduct } from "./catalog.ts";
import { AgentJournal, validSession } from "./journal.ts";
import { PayPalClient, PayPalError, configFromEnv, approveLink, assertOrderId } from "./paypal.ts";
import { MandateStore, MandateError, validMandateId, MAX_BUDGET_CENTS } from "./mandates.ts";
import { OrderStore, type OrderRecord } from "./orders.ts";
import { assessStoreClaim, assessPayPalDispute, type AgentContext, type DeskCase } from "./disputedesk/desk.ts";
import { createLlm, type Llm } from "./llm.ts";
import { composePayments, type PaymentsPort } from "./payments.ts";
import { ToolkitPayments } from "./toolkit.ts";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createStoreMcpServer, mcpSessionFor, validMandate } from "./mcp.ts";
import { validateStep, agentStep } from "./agent.ts";

export type { PaymentsPort };

export interface AppDeps {
  payments: PaymentsPort;
  journal: AgentJournal;
  orders?: OrderStore;
  mandates?: MandateStore;
  llm?: Llm | null;
  baseUrl: string;
  webDir?: string;
  version?: string;
  /** If set, merchant actions (refund / decline) need header X-Merchant-Key. */
  merchantKey?: string;
  /** Agents may only create orders under a buyer mandate (default true). */
  requireMandate?: boolean;
  trustProxy?: boolean;
  now?: () => Date;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  txt: "text/plain; charset=utf-8",
  json: "application/json; charset=utf-8",
};
const PAGES: Record<string, string> = { "/": "index.html", "/order": "order.html", "/merchant": "merchant.html" };
const STATIC_RE = /^\/(?:[a-z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.(html|js|css|svg|png|ico|txt)$/;
const SECURITY_HEADERS = { "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin" };

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS, ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, max = 16 * 1024): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw Object.assign(new Error("body too large"), { http: 413 });
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid JSON"), { http: 400 });
  }
}

const httpError = (http: number, message: string) => Object.assign(new Error(message), { http });

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

/** Mask API keys / bearer tokens of the providers we use before anything is logged. */
export function maskKeys(text: string): string {
  return text
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "AIza***")
    .replace(/AQ\.[0-9A-Za-z_.-]{20,}/g, "AQ.***")
    .replace(/gsk_[0-9A-Za-z]{20,}/g, "gsk_***")
    .replace(/sk-[0-9A-Za-z_-]{20,}/g, "sk-***")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer ***")
    .replace(/([?&]key=)[^&\s]+/g, "$1***");
}

export function maskEmail(e: unknown): string | null {
  if (typeof e !== "string" || !e.includes("@")) return null;
  const [u, d] = e.split("@");
  return `${u.slice(0, 1)}***@${d}`;
}

/** Fixed-window limiter per key. Small and in-memory: enough for a public sandbox demo. */
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  limit: number;
  windowMs: number;
  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }
  allow(key: string, now = Date.now()): boolean {
    if (this.hits.size > 10_000) this.hits.clear();
    const h = this.hits.get(key);
    if (!h || h.reset <= now) {
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      return true;
    }
    h.n += 1;
    return h.n <= this.limit;
  }
}

export function createHandler(deps: AppDeps) {
  const webDir = resolve(deps.webDir ?? join(HERE, "..", "web"));
  const orders = deps.orders ?? new OrderStore();
  const mandates = deps.mandates ?? new MandateStore();
  const now = deps.now ?? (() => new Date());
  const requireMandate = deps.requireMandate ?? true;
  const writeLimiter = new RateLimiter(60, 10 * 60_000);
  const llmLimiter = new RateLimiter(60, 10 * 60_000);
  const mcpLimiter = new RateLimiter(300, 10 * 60_000);
  // The /mcp endpoint calls this same API over loopback; this per-process key lets those inner calls carry the
  // outer client's IP for rate limiting (nobody else can set it).
  const internalKey = randomBytes(16).toString("hex");
  const isInternal = (v: unknown) => typeof v === "string" && v.length === internalKey.length && timingSafeEqual(Buffer.from(v), Buffer.from(internalKey));
  let disputeCache: { at: number; cases: DeskCase[]; error: string | null } | null = null;

  function agentContext(o: OrderRecord): AgentContext {
    return { calls: deps.journal.receipt(o.orderId).calls, mandate: o.mandateId ? mandates.view(o.mandateId, now()) : null };
  }

  /** Orders survive a restart only in PayPal: rebuild the store record from the PayPal order if needed. */
  async function loadOrder(id: string): Promise<OrderRecord> {
    const known = orders.getOrder(id);
    if (known) return known;
    const o = await deps.payments.getOrder(id);
    const pu = o?.purchase_units?.[0];
    const custom = String(pu?.custom_id ?? "");
    if (pu?.reference_id !== "store") throw httpError(404, "order not found in this store");
    const session = custom.startsWith("agent:") ? custom.split(":")[1] ?? null : null;
    const mandateId = custom.split(":")[2] ?? null;
    const cap = pu?.payments?.captures?.[0];
    return orders.addOrder({
      orderId: o.id,
      createdAt: o.create_time ?? now().toISOString(),
      channel: session ? "agent" : "human",
      session: validSession(session) ? session : null,
      mandateId: validMandateId(mandateId) ? mandateId : null,
      items: (pu?.items ?? []).map((i: any) => ({ sku: String(i.sku ?? ""), name: String(i.name ?? ""), unitPrice: String(i.unit_amount?.value ?? ""), quantity: Number(i.quantity ?? 1) })),
      total: String(pu?.amount?.value ?? ""),
      currency: String(pu?.amount?.currency_code ?? "USD"),
      status: String(o.status ?? ""),
      captureId: cap?.id ?? null,
      capturedAt: cap?.create_time ?? null,
      payerEmail: maskEmail(o?.payer?.email_address),
    });
  }

  // One capture per order at a time: onApprove and the return URL can fire together (Jules review).
  const inFlightCaptures = new Map<string, Promise<ReturnType<typeof orderView>>>();
  const inFlightRefunds = new Set<string>();

  function capture(id: string) {
    const running = inFlightCaptures.get(id);
    if (running) return running;
    const task = captureOnce(id).finally(() => inFlightCaptures.delete(id));
    inFlightCaptures.set(id, task);
    return task;
  }

  async function captureOnce(id: string) {
    const rec = await loadOrder(id);
    // Already captured (PayPal return URL reloaded, onApprove + return both fired): read, do not capture again.
    if (rec.status === "COMPLETED" && rec.captureId) return orderView(await deps.payments.getOrder(id));
    const raw = await deps.payments.captureOrder(id, `cap-${id}`);
    const v = orderView(raw);
    orders.updateOrder(id, {
      status: String(v.status ?? rec.status),
      captureId: v.captureId ?? rec.captureId,
      capturedAt: v.captureId ? now().toISOString() : rec.capturedAt,
      payerEmail: maskEmail(raw?.payer?.email_address) ?? rec.payerEmail,
    });
    return v;
  }

  return async function handler(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const agentTool = req.headers["x-agent-tool"];
    const agentSession = req.headers["x-agent-session"];
    const headerMandate = req.headers["x-agent-mandate"];
    // Agents identify themselves with these headers (WebMCP tools and the MCP server always send them). A request
    // with only some of them is refused below instead of silently being treated as a human (Jules review).
    // An agent that sends none of them looks like a human: the real limit is that every payment needs the buyer's
    // own approval in PayPal (see README, threat model).
    const claimsAgent = agentTool !== undefined || agentSession !== undefined || headerMandate !== undefined;
    const isAgent = claimsAgent && typeof agentTool === "string" && agentTool.length > 0 && validSession(agentSession);
    const started = Date.now();
    const fwd = deps.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "";
    const innerIp = isInternal(req.headers["x-internal-mcp"]) ? String(req.headers["x-mcp-client-ip"] ?? "").slice(0, 64) : "";
    const ip = innerIp || fwd || req.socket.remoteAddress || "unknown";
    let toolArgs: unknown = Object.fromEntries(url.searchParams);
    const journal = (ok: boolean, summary: string, orderId?: string, result?: unknown) => {
      if (!isAgent) return;
      deps.journal.record({ session: agentSession as string, tool: String(agentTool).slice(0, 40), args: toolArgs, ok, summary, orderId, ms: Date.now() - started, result });
    };
    const humanOnly = (what: string) => {
      if (claimsAgent) throw httpError(403, `${what} is buyer-only: an agent cannot do this`);
    };
    const merchantOnly = () => {
      if (claimsAgent) throw httpError(403, "merchant actions are not available to agents");
      if (deps.merchantKey && req.headers["x-merchant-key"] !== deps.merchantKey) throw httpError(401, "merchant key required");
    };
    const limitWrites = () => {
      if (!writeLimiter.allow(ip)) throw httpError(429, "too many requests, slow down");
    };

    try {
      // ---------- static ----------
      if (req.method === "GET" && (PAGES[path] || STATIC_RE.test(path))) {
        const rel = PAGES[path] ?? path.slice(1);
        const file = resolve(webDir, rel);
        if (!file.startsWith(webDir + sep) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, { error: "not found" });
        const ext = file.split(".").pop()!;
        const headers: Record<string, string> = { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": ext === "html" ? "no-store" : "public, max-age=300", ...SECURITY_HEADERS };
        // PayPal JS SDK v6 opens the approval popup; the page must keep a handle to it.
        if (ext === "html") headers["cross-origin-opener-policy"] = "same-origin-allow-popups";
        res.writeHead(200, headers);
        res.end(readFileSync(file));
        return;
      }

      // ---------- MCP (Streamable HTTP, stateless): the six store tools for external agents ----------
      if (path === "/mcp") {
        if (req.method !== "POST") {
          return send(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "this MCP endpoint is stateless: use POST" }, id: null }, { allow: "POST" });
        }
        if (!mcpLimiter.allow(ip)) throw httpError(429, "too many MCP requests, slow down");
        const body = await readJson(req, 64 * 1024);
        const hdr = req.headers["x-agent-mandate"];
        const bearer = String(req.headers.authorization ?? "").match(/^Bearer\s+(md_[a-f0-9]{16})$/)?.[1];
        const mandate = validMandate(hdr) ? hdr : validMandate(bearer) ? bearer : null;
        const local = req.socket.localAddress ?? "127.0.0.1";
        const inner = `http://${local.includes(":") ? `[${local}]` : local}:${req.socket.localPort}`;
        const mcp = createStoreMcpServer({ base: inner, session: mcpSessionFor(req.headers["x-agent-session"], mandate), mandate, headers: { "x-internal-mcp": internalKey, "x-mcp-client-ip": ip } });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on("close", () => {
          transport.close().catch(() => {});
          mcp.close().catch(() => {});
        });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      if (claimsAgent && !isAgent && (path.startsWith("/api/") || path.startsWith("/paypal/"))) {
        throw httpError(400, "agent requests need X-Agent-Tool and X-Agent-Session (6-64 chars A-Z a-z 0-9 _ -)");
      }

      if (req.method === "GET" && path === "/api/health") return send(res, 200, { ok: true, version: deps.version ?? "dev", sandbox: true, toolkit: deps.payments.toolkit?.version ?? null });

      if (req.method === "GET" && path === "/api/config") {
        return send(res, 200, {
          clientId: deps.payments.clientId,
          currency: "USD",
          sdkUrl: "https://www.sandbox.paypal.com/web-sdk/v6/core",
          sandbox: true,
          llm: Boolean(deps.llm),
          maxBudget: (MAX_BUDGET_CENTS / 100).toFixed(2),
          version: deps.version ?? "dev",
        });
      }

      // ---------- catalog ----------
      if (req.method === "GET" && path === "/api/products") {
        const maxPrice = url.searchParams.has("max_price") ? Number(url.searchParams.get("max_price")) : undefined;
        const items = searchProducts(url.searchParams.get("q") ?? "", { maxPrice: Number.isFinite(maxPrice) ? maxPrice : undefined, limit: Number(url.searchParams.get("limit") ?? 5) });
        journal(true, `${items.length} result(s)`, undefined, items.map((p) => ({ sku: p.sku, name: p.name, price: p.price, description: p.description })));
        return send(res, 200, { currency: "USD", items });
      }

      // ---------- mandates ----------
      if (req.method === "POST" && path === "/api/mandates") {
        humanOnly("delegating a budget");
        limitWrites();
        return send(res, 201, mandates.create(await readJson(req), now()));
      }
      const mm = path.match(/^\/api\/mandates\/([^/]+)(\/revoke)?$/);
      if (mm) {
        const id = decodeURIComponent(mm[1]);
        toolArgs = { mandateId: id };
        if (req.method === "GET" && !mm[2]) {
          const v = mandates.view(id, now());
          if (!v) {
            journal(false, "mandate not found");
            return send(res, 404, { error: "mandate not found" });
          }
          journal(true, `${v.status} remaining ${v.remaining} USD`);
          return send(res, 200, v);
        }
        if (req.method === "POST" && mm[2]) {
          humanOnly("revoking a mandate");
          if (!mandates.revoke(id)) return send(res, 404, { error: "mandate not found" });
          return send(res, 200, mandates.view(id, now()));
        }
      }

      // ---------- orders ----------
      if (req.method === "POST" && path === "/api/orders") {
        limitWrites();
        const body = await readJson(req);
        toolArgs = body;
        const priced = priceOrder(body?.items);
        const mandateId = isAgent ? (typeof headerMandate === "string" && headerMandate ? headerMandate : body?.mandate_id) : null;
        if (isAgent && requireMandate && !mandateId) throw new MandateError("NOT_FOUND", "no spending mandate: the buyer must delegate a budget on the store page before an agent can order");
        const categories = [...new Set(priced.items.map((i) => findProduct(i.sku)!.category))];
        const hold = mandateId ? mandates.reserve(String(mandateId), priced.totalCents, categories, now()) : null;
        let order: any;
        try {
          order = await deps.payments.createOrder(
            {
              currency: priced.currency,
              total: priced.total,
              items: priced.items,
              referenceId: "store",
              customId: isAgent ? `agent:${agentSession}${mandateId ? `:${mandateId}` : ""}` : "human",
              // Agent orders get a redirect approval link the agent can hand to the buyer; human orders are
              // approved in the PayPal JS SDK v6 popup on our own page (no return URL needed).
              ...(isAgent || body?.flow === "redirect" ? { returnUrl: `${deps.baseUrl}/paypal/return`, cancelUrl: `${deps.baseUrl}/paypal/cancel` } : {}),
            },
            randomUUID(),
          );
        } catch (e) {
          hold?.release();
          throw e;
        }
        hold?.commit(order.id);
        orders.addOrder({
          orderId: order.id,
          createdAt: now().toISOString(),
          channel: isAgent ? "agent" : "human",
          session: isAgent ? (agentSession as string) : null,
          mandateId: mandateId ? String(mandateId) : null,
          items: priced.items,
          total: priced.total,
          currency: priced.currency,
          status: String(order.status ?? "CREATED"),
        });
        const view = {
          ...orderView(order),
          total: `${priced.total} ${priced.currency}`,
          items: priced.items,
          approveUrl: approveLink(order),
          orderPage: `${deps.baseUrl}/order?id=${encodeURIComponent(order.id)}`,
          mandate: mandateId ? mandates.view(String(mandateId), now()) : undefined,
          next: "The buyer must approve this payment in PayPal (PayPal button on the store page, or approveUrl). The agent cannot approve or capture payments.",
        };
        journal(true, `order ${order.id} ${priced.total} ${priced.currency}`, order.id);
        return send(res, 201, view);
      }

      const m = path.match(/^\/api\/orders\/([^/]+)(\/capture|\/cancel|\/agent-log|\/claims)?$/);
      if (m) {
        const id = assertOrderId(decodeURIComponent(m[1]));
        toolArgs = { orderId: id };
        if (req.method === "GET" && !m[2]) {
          const rec = await loadOrder(id);
          const v = orderView(await deps.payments.getOrder(id));
          if (v.status && v.status !== rec.status && rec.status !== "CANCELLED") orders.updateOrder(id, { status: v.status, captureId: v.captureId ?? rec.captureId });
          const out = { ...v, channel: rec.channel, items: rec.items, total: `${rec.total} ${rec.currency}`, refunds: rec.refunds, claims: orders.claimsFor(id), mandateId: rec.mandateId, createdAt: rec.createdAt };
          journal(true, `status ${v.status}`, id);
          return send(res, 200, out);
        }
        if (req.method === "POST" && m[2] === "/capture") {
          if (isAgent) {
            journal(false, "capture refused for agents", id);
            return send(res, 403, { error: "capture is merchant-side only: the buyer approves in PayPal" });
          }
          humanOnly("capture");
          limitWrites();
          return send(res, 200, await capture(id));
        }
        if (req.method === "POST" && m[2] === "/cancel") {
          humanOnly("cancel");
          const rec = await loadOrder(id);
          if (rec.status === "COMPLETED") return send(res, 409, { error: "order is already paid; request a refund instead" });
          mandates.releaseOrder(id);
          orders.updateOrder(id, { status: "CANCELLED" });
          return send(res, 200, { orderId: id, status: "CANCELLED" });
        }
        if (req.method === "GET" && m[2] === "/agent-log") return send(res, 200, deps.journal.receipt(id));
        if (req.method === "POST" && m[2] === "/claims") {
          limitWrites();
          const body = await readJson(req);
          toolArgs = { orderId: id, ...body };
          const rec = await loadOrder(id);
          if (isAgent && rec.session !== agentSession && !(rec.mandateId && headerMandate === rec.mandateId)) {
            throw httpError(403, "an agent can only raise claims for orders it placed under the buyer's mandate");
          }
          // Refresh status from PayPal so a claim on a just-paid order works after a restart.
          if (rec.status !== "COMPLETED") {
            const v = orderView(await deps.payments.getOrder(id));
            orders.updateOrder(id, { status: String(v.status), captureId: v.captureId ?? rec.captureId });
          }
          const claim = orders.openClaim({ orderId: id, kind: body?.kind, reason: body?.reason, note: body?.note, by: isAgent ? "agent" : "buyer", session: isAgent ? (agentSession as string) : null }, now());
          journal(true, `${claim.kind} ${claim.claimId} (${claim.reason})`, id);
          return send(res, 201, { ...claim, next: "The merchant reviews the claim in DisputeDesk; a refund is issued through PayPal if approved." });
        }
      }

      if (req.method === "GET" && (path === "/paypal/return" || path === "/paypal/cancel")) {
        const id = assertOrderId(url.searchParams.get("token") ?? "");
        if (path === "/paypal/return") {
          const v = await capture(id);
          res.writeHead(302, { location: `/order?id=${encodeURIComponent(id)}&status=${encodeURIComponent(String(v.status))}` });
        } else {
          const rec = await loadOrder(id);
          if (rec.status !== "COMPLETED") {
            mandates.releaseOrder(id);
            orders.updateOrder(id, { status: "CANCELLED" });
          }
          res.writeHead(302, { location: `/order?id=${encodeURIComponent(id)}&cancelled=1` });
        }
        res.end();
        return;
      }

      // ---------- agent planner (LLM) ----------
      if (req.method === "POST" && path === "/api/agent/step") {
        if (!deps.llm) return send(res, 503, { error: "no LLM configured on this server", fallback: true });
        if (!llmLimiter.allow(ip)) throw httpError(429, "agent step limit reached, try again later");
        const input = validateStep(await readJson(req, 64 * 1024));
        try {
          return send(res, 200, await agentStep(deps.llm, input));
        } catch (e) {
          // Provider errors can echo request details; never forward them, and mask keys before logging.
          console.warn("agent step failed:", maskKeys(String((e as Error)?.message ?? e)).slice(0, 300));
          return send(res, 502, { error: "LLM provider failed", fallback: true });
        }
      }

      // ---------- merchant ----------
      if (req.method === "GET" && path === "/api/merchant/orders") return send(res, 200, { orders: orders.listOrders() });
      if (req.method === "GET" && path === "/api/merchant/journal") return send(res, 200, { entries: deps.journal.list(Number(url.searchParams.get("limit") ?? 500)) });
      if (req.method === "GET" && path === "/api/merchant/summary") {
        const all = orders.listOrders();
        const paid = all.filter((o) => o.status === "COMPLETED");
        const sum = (xs: OrderRecord[]) => xs.reduce((s, o) => s + Math.round(Number(o.total) * 100), 0) / 100;
        return send(res, 200, {
          orders: all.length,
          agentOrders: all.filter((o) => o.channel === "agent").length,
          paid: paid.length,
          revenue: sum(paid).toFixed(2),
          agentRevenue: sum(paid.filter((o) => o.channel === "agent")).toFixed(2),
          openClaims: orders.listClaims().filter((c) => c.status === "OPEN").length,
          journal: deps.journal.stats(),
        });
      }
      if (req.method === "GET" && path === "/api/merchant/cases") {
        const store = orders.listClaims().flatMap((c) => {
          const o = orders.getOrder(c.orderId);
          return o ? [assessStoreClaim(c, o, agentContext(o), now())] : [];
        });
        if (!disputeCache || Date.now() - disputeCache.at > 60_000 || url.searchParams.has("refresh")) {
          try {
            const list = await deps.payments.listDisputes(20);
            const items: any[] = (list?.items ?? []).slice(0, 10);
            const cases: DeskCase[] = [];
            for (const it of items) {
              let d = it;
              try {
                d = await deps.payments.getDispute(String(it.dispute_id));
              } catch {
                // keep the summary
              }
              const capId = d?.disputed_transactions?.[0]?.seller_transaction_id;
              const o = orders.listOrders().find((x) => x.captureId && x.captureId === capId);
              cases.push(assessPayPalDispute(d, o, o ? agentContext(o) : { calls: [], mandate: null }, now()));
            }
            disputeCache = { at: Date.now(), cases, error: null };
          } catch (e) {
            disputeCache = { at: Date.now(), cases: [], error: e instanceof PayPalError ? `PayPal Disputes API: ${e.issue ?? "HTTP " + e.status}` : "PayPal Disputes API unavailable" };
          }
        }
        return send(res, 200, { cases: [...store, ...disputeCache.cases], paypalError: disputeCache.error });
      }
      const mc = path.match(/^\/api\/merchant\/claims\/(CLM-[0-9A-F]{8})\/(refund|decline)$/);
      if (req.method === "POST" && mc) {
        merchantOnly();
        limitWrites();
        const claim = orders.getClaim(mc[1]);
        if (!claim) return send(res, 404, { error: "claim not found" });
        if (claim.status !== "OPEN") return send(res, 409, { error: `claim is already ${claim.status}` });
        const o = orders.getOrder(claim.orderId)!;
        if (mc[2] === "decline") {
          const body = await readJson(req);
          return send(res, 200, orders.resolveClaim(claim.claimId, { status: "DECLINED", resolution: String(body?.reason ?? "declined by merchant").slice(0, 200) }, now()));
        }
        if (!o.captureId) return send(res, 409, { error: "order has no capture to refund" });
        // PayPal-Request-Id already makes the refund idempotent at PayPal; the lock keeps our records single.
        if (inFlightRefunds.has(claim.claimId)) return send(res, 409, { error: "a refund for this claim is already in progress" });
        inFlightRefunds.add(claim.claimId);
        try {
          const r = await deps.payments.refundCapture(o.captureId, { note: `Refund for order ${o.orderId} (${claim.claimId})` }, `refund-${claim.claimId}`);
          orders.addRefund(o.orderId, { refundId: String(r?.id ?? ""), amount: String(r?.amount?.value ?? o.total), status: String(r?.status ?? ""), at: now().toISOString(), claimId: claim.claimId });
          return send(res, 200, orders.resolveClaim(claim.claimId, { status: "REFUNDED", resolution: `refund ${r?.id ?? ""} ${r?.status ?? ""}`.trim(), refundId: r?.id ?? null }, now()));
        } finally {
          inFlightRefunds.delete(claim.claimId);
        }
      }

      const ma = path.match(/^\/api\/merchant\/disputes\/(PP-[A-Z0-9-]{6,40})\/accept$/);
      if (req.method === "POST" && ma) {
        merchantOnly();
        limitWrites();
        if (!deps.payments.acceptDisputeClaim) return send(res, 501, { error: "accepting PayPal disputes needs the PayPal Agent Toolkit" });
        const body = await readJson(req);
        const r = await deps.payments.acceptDisputeClaim(ma[1], String(body?.note ?? "We accept the claim; PayPal refunds the buyer."));
        disputeCache = null;
        return send(res, 200, { disputeId: ma[1], accepted: true, links: Array.isArray(r?.links) ? r.links.length : 0, via: "@paypal/agent-toolkit accept_dispute_claim" });
      }
      if (req.method === "GET" && path === "/api/merchant/toolkit") {
        const t = deps.payments.toolkit ?? null;
        return send(res, 200, { toolkit: t, calls: deps.payments.toolkitCalls?.(Number(url.searchParams.get("limit") ?? 50)) ?? [] });
      }

      if (req.method === "GET" && path === "/api/journal/stats") return send(res, 200, deps.journal.stats());

      return send(res, 404, { error: "not found" });
    } catch (e: any) {
      const status = e?.http ?? (e instanceof MandateError ? (e.code === "INVALID" ? 400 : 403) : e instanceof PayPalError ? (e.status >= 400 && e.status < 500 ? 422 : 502) : 400);
      const msg = e instanceof PayPalError ? `payment provider error${e.issue ? ": " + e.issue : ""}` : String(e?.message ?? "error").slice(0, 200);
      journal(false, msg);
      return send(res, status, { error: msg, code: e instanceof MandateError ? e.code : undefined, debugId: e instanceof PayPalError ? e.debugId : undefined });
    }
  };
}

function gitVersion(): string {
  if (process.env.RENDER_GIT_COMMIT) return process.env.RENDER_GIT_COMMIT.slice(0, 7);
  try {
    return execSync("git rev-parse --short HEAD", { cwd: HERE, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "dev";
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? "127.0.0.1";
  const baseUrl = (process.env.PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
  const cfg = configFromEnv();
  const own = new PayPalClient(cfg);
  // Order status, disputes and refunds go through the official PayPal Agent Toolkit (src/toolkit.ts).
  const payments = composePayments(own, new ToolkitPayments({ token: () => own.getAccessToken(), secrets: [cfg.clientId, cfg.secret] }));
  const dataDir = join(HERE, "..", "data");
  const journal = new AgentJournal(join(dataDir, "agent_journal.jsonl"));
  const orders = new OrderStore(join(dataDir, "orders.json"));
  createServer(
    createHandler({
      payments,
      journal,
      orders,
      llm: createLlm(),
      baseUrl,
      version: gitVersion(),
      merchantKey: process.env.MERCHANT_KEY || undefined,
      trustProxy: process.env.TRUST_PROXY === "1" || Boolean(process.env.RENDER),
    }),
  ).listen(port, host, () => {
    console.log(`agent store on ${baseUrl} (PayPal sandbox, listening ${host}:${port})`);
  });
}
