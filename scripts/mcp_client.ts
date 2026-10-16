// A minimal external MCP agent client (official MCP SDK) for demos and the browser E2E.
// Usage:
//   node scripts/mcp_client.ts --url http://localhost:8787 [--mandate md_...] [--stdio] tools
//   node scripts/mcp_client.ts --url http://localhost:8787 --mandate md_... call create_order '{"items":[{"sku":"TEA-SENCHA-80","quantity":1}]}'
// --stdio launches src/mcp-stdio.ts as a child process instead of using the store's /mcp HTTP endpoint.
// Prints one JSON line: {tool, isError, result} or {tools:[...]}.
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const argv = process.argv.slice(2);
const opt = (k: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
const url = (opt("--url") ?? "http://localhost:8787").replace(/\/$/, "");
const mandate = opt("--mandate");
const positional = argv.filter((a, i) => !a.startsWith("--") && !["--url", "--mandate"].includes(argv[i - 1]));
const [cmd = "tools", tool, rawArgs = "{}"] = positional;

const client = new Client({ name: "leafline-external-agent", version: "1.0.0" });
const transport = argv.includes("--stdio")
  ? new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../src/mcp-stdio.ts", import.meta.url))],
      env: { ...process.env, STORE_URL: url, ...(mandate ? { STORE_MANDATE: mandate } : {}) } as Record<string, string>,
      stderr: "ignore",
    })
  : new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: mandate ? { "x-agent-mandate": mandate } : {} } });
await client.connect(transport);
try {
  if (cmd === "tools") {
    const { tools } = await client.listTools();
    console.log(JSON.stringify({ tools: tools.map((t) => t.name) }));
  } else if (cmd === "call" && tool) {
    const r: any = await client.callTool({ name: tool, arguments: JSON.parse(rawArgs) });
    let result: unknown = r.content?.[0]?.text;
    try {
      result = JSON.parse(String(result));
    } catch {
      // keep text
    }
    console.log(JSON.stringify({ tool, isError: Boolean(r.isError), result }));
  } else {
    console.error("usage: mcp_client.ts [--url U] [--mandate M] [--stdio] tools | call <tool> '<json>'");
    process.exitCode = 2;
  }
} finally {
  await client.close();
}
