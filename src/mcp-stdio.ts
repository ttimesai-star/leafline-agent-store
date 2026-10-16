// MCP server of the store over stdio. Configure in an MCP client, e.g. Claude Desktop / Claude Code:
//   command: node   args: [".../src/mcp-stdio.ts"]
//   env: STORE_URL=https://<store>  STORE_MANDATE=md_<16 hex> (the buyer creates it on the store page)
// Optional STORE_AGENT_SESSION (journal session id). Logs go to stderr only (stdout is the MCP channel).
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createStoreMcpServer, newMcpSession, validMandate } from "./mcp.ts";

const base = (process.env.STORE_URL ?? "http://localhost:8787").replace(/\/$/, "");
const mandate = process.env.STORE_MANDATE ?? "";
const session = /^[A-Za-z0-9_-]{6,64}$/.test(process.env.STORE_AGENT_SESSION ?? "") ? process.env.STORE_AGENT_SESSION! : newMcpSession();
if (mandate && !validMandate(mandate)) {
  console.error("STORE_MANDATE must look like md_<16 hex>; ignoring it (the agent can only search)");
}
const server = createStoreMcpServer({ base, session, mandate: validMandate(mandate) ? mandate : null });
await server.connect(new StdioServerTransport());
console.error(`store MCP server on stdio -> ${base} (session ${session}, mandate ${validMandate(mandate) ? "set" : "none"})`);
