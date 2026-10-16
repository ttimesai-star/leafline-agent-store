import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { createHandler } from "../src/server.ts";
import { AgentJournal } from "../src/journal.ts";

const get = (port: number, path: string, headers: Record<string, string> = {}) =>
  new Promise<{ status: number; headers: any; size: number }>((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let size = 0;
      res.on("data", (c) => (size += c.length));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, size }));
    });
    r.on("error", reject);
    r.end();
  });

test("AG Studio bundle is served from node_modules, gzipped on request; licence only from env", async () => {
  for (const lic of [undefined, "TEST-LICENCE"]) {
    const srv = createServer(createHandler({ payments: { clientId: "x" } as any, journal: new AgentJournal(), baseUrl: "http://x", agStudioLicense: lic }));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as AddressInfo).port;
    try {
      const raw = await get(port, "/vendor/ag-studio.js");
      const gz = await get(port, "/vendor/ag-studio.js", { "accept-encoding": "gzip, deflate, br" });
      assert.equal(raw.status, 200);
      assert.equal(gz.headers["content-encoding"], "gzip");
      assert.ok(raw.size > 1_000_000 && gz.size < raw.size / 2, `raw ${raw.size}, gzip ${gz.size}`);
      const cfg = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json();
      assert.equal(cfg.agStudioLicense, lic ?? null);
    } finally {
      await new Promise<void>((r) => {
        srv.closeAllConnections();
        srv.close(() => r());
      });
    }
  }
});
