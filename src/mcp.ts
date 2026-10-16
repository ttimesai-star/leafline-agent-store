// The store's MCP server: the same six tools the page registers over WebMCP (web/webmcp.js — one definition,
// shared), offered to external AI agents over the Model Context Protocol.
//   - stdio:  node src/mcp-stdio.ts      (Claude Desktop / Claude Code / MCP Inspector launch it locally)
//   - HTTP:   POST {store}/mcp           (Streamable HTTP, stateless; mounted by src/server.ts)
// The MCP layer enforces nothing by itself on purpose: every tool is a plain call to the store's JSON API with
// X-Agent-Tool / X-Agent-Session / X-Agent-Mandate headers, so the store server applies exactly the same
// mandate checks (budget, per-order cap, categories, expiry, revoke), journaling and agent restrictions
// (no capture, no merchant actions) as for the in-page WebMCP agent.
import { createHash, randomBytes } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildStoreTools, TOOL_NAMES } from "../web/webmcp.js";

export const MCP_SERVER_NAME = "leafline-agent-store";
export const MCP_SERVER_VERSION = "0.1.0";

const SESSION_RE = /^[A-Za-z0-9_-]{6,64}$/;
const MANDATE_RE = /^md_[a-f0-9]{16}$/;

export interface StoreMcpOptions {
  /** Store base URL the tools call, e.g. http://localhost:8787 */
  base: string;
  /** Agent session id written to the journal (X-Agent-Session). */
  session: string;
  /** Spending mandate id the buyer gave this agent (X-Agent-Mandate). Without it the agent can search only. */
  mandate?: string | null;
  fetchImpl?: typeof fetch;
  /** Extra headers on every store call (used by the in-process HTTP endpoint). */
  headers?: Record<string, string>;
}

export function newMcpSession(): string {
  return "mcp_" + randomBytes(8).toString("hex");
}

/** Stable journal session for an HTTP MCP client: explicit header, else derived from the mandate, else new. */
export function mcpSessionFor(headerSession: unknown, mandate: string | null): string {
  if (typeof headerSession === "string" && SESSION_RE.test(headerSession)) return headerSession;
  if (mandate) return "mcp_" + createHash("sha256").update(mandate).digest("hex").slice(0, 16);
  return newMcpSession();
}

export function validMandate(m: unknown): m is string {
  return typeof m === "string" && MANDATE_RE.test(m);
}

export function createStoreMcpServer(opts: StoreMcpOptions): Server {
  const baseFetch = opts.fetchImpl ?? globalThis.fetch;
  const fetchImpl = (opts.headers
    ? (url: any, init: any = {}) => baseFetch(url, { ...init, headers: { ...(init.headers ?? {}), ...opts.headers } })
    : baseFetch) as typeof fetch;
  const mandate = validMandate(opts.mandate) ? opts.mandate : null;
  const tools: any[] = buildStoreTools({ fetchImpl, base: opts.base.replace(/\/$/, ""), session: opts.session, getMandate: () => mandate });
  const byName = new Map(tools.map((t) => [t.name, t]));
  const server = new Server(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Leafline tea shop (PayPal sandbox). Call get_budget first: you may only order inside the spending mandate the buyer delegated " +
        "(budget, per-order cap, categories, expiry); the store refuses anything outside it. create_order returns an approveUrl: " +
        "the buyer approves and pays in PayPal, you cannot pay or capture.",
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, ...(t.annotations ? { annotations: t.annotations } : {}) })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const t = byName.get(req.params.name);
    if (!t) return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: `unknown tool ${String(req.params.name).slice(0, 40)}`, tools: TOOL_NAMES }) }] };
    const args = req.params.arguments && typeof req.params.arguments === "object" ? req.params.arguments : {};
    return await t.execute(args);
  });
  return server;
}
