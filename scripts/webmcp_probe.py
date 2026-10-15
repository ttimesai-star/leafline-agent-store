"""Probe WebMCP support in the installed Chrome against the running storefront.

Usage: python scripts/webmcp_probe.py [--url http://localhost:8787/] [--flags|--no-flags] [--polyfill PATH] [--call]
- --flags: launch Chrome with --enable-features=WebMCP,WebMCPTesting (chrome://flags/#enable-webmcp-testing)
- --polyfill: inject a local polyfill bundle (e.g. MCP-B) before page scripts
- --call: run search_products -> create_order -> get_order_status through the browser-side WebMCP layer
Prints JSON lines; no secrets involved.
"""
import json
import sys

from playwright.sync_api import sync_playwright

INSPECT = r"""
async () => {
  const out = { ua: navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] };
  const nav = navigator.modelContext, doc = document.modelContext;
  out.navigator_modelContext = nav === undefined ? "undefined" : Object.prototype.toString.call(nav);
  out.document_modelContext = doc === undefined ? "undefined" : Object.prototype.toString.call(doc);
  const protoKeys = (o) => { const ks = new Set(); let p = o; while (p && p !== Object.prototype) { Object.getOwnPropertyNames(p).forEach(k => ks.add(k)); p = Object.getPrototypeOf(p); } return [...ks].sort(); };
  if (nav) out.navigator_modelContext_keys = protoKeys(nav);
  if (doc) out.document_modelContext_keys = protoKeys(doc);
  out.modelContextTesting = navigator.modelContextTesting === undefined ? "undefined" : protoKeys(navigator.modelContextTesting);
  out.page_status = window.__webmcpStatus ?? null;
  const t = navigator.modelContextTesting;
  if (t && typeof t.listTools === "function") {
    try { const ls = await t.listTools(); out.testing_listTools = (ls || []).map(x => x.name ?? x); } catch (e) { out.testing_listTools_error = `${e.name}: ${e.message}`; }
  }
  return out;
}
"""

CALL = r"""
async () => {
  // Chrome 155 (flag WebMCP,WebMCPTesting) exposes document.modelContext with getTools/executeTool.
  const mc = document.modelContext ?? navigator.modelContext;
  const t = mc && typeof mc.executeTool === "function" ? mc : navigator.modelContextTesting;
  const res = { via: t === mc ? "document.modelContext" : "modelContextTesting" };
  if (!t || typeof t.executeTool !== "function") { res.error = "executeTool not available"; return res; }
  const textOf = (r) => { try { const o = typeof r === "string" ? JSON.parse(r) : r; return JSON.parse(o?.content?.[0]?.text ?? "null"); } catch { return null; } };
  let byName = {};
  try {
    const tools = await t.getTools?.();
    for (const x of tools ?? []) byName[x.name] = x;
    res.getTools = (tools ?? []).map((x) => ({ name: x.name, hasSchema: !!(x.inputSchema), keys: Object.keys(x) }));
  } catch (e) { res.getTools_error = `${e.name}: ${e.message}`; }
  for (const shape of ["object", "string"]) {
    const a = { query: "green tea", max_price: 12 };
    try {
      const r = await t.executeTool(byName.search_products, shape === "object" ? a : JSON.stringify(a));
      res[`search_${shape}`] = { raw_type: typeof r, raw: JSON.stringify(r).slice(0, 300), first_sku: textOf(r)?.items?.[0]?.sku };
    } catch (e) { res[`search_${shape}_error`] = `${e.name}: ${e.message}`; }
  }
  const okShape = res.search_object?.first_sku ? "object" : res.search_string?.first_sku ? "string" : null;
  if (!okShape) return res;
  const pack = (a) => okShape === "object" ? a : JSON.stringify(a);
  try {
    const o = textOf(await t.executeTool(byName.create_order, pack({ items: [{ sku: res[`search_${okShape}`].first_sku, quantity: 1 }] })));
    res.create_order = o;
    if (o?.orderId) {
      res.get_order_status = textOf(await t.executeTool(byName.get_order_status, pack({ order_id: o.orderId })));
      res.agent_receipt = await fetch(`/api/orders/${o.orderId}/agent-log`).then((x) => x.json());
    }
  } catch (e) { res.order_error = `${e.name}: ${e.message}`; }
  return res;
}
"""


def main() -> int:
    args = sys.argv[1:]
    url = args[args.index("--url") + 1] if "--url" in args else "http://localhost:8787/"
    launch_args = ["--enable-features=WebMCP,WebMCPTesting"] if "--flags" in args else []
    polyfill = args[args.index("--polyfill") + 1] if "--polyfill" in args else None
    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", headless=True, args=launch_args)
        page = b.new_page()
        console = []
        page.on("console", lambda m: console.append(f"{m.type}: {m.text}"[:300]))
        page.on("pageerror", lambda e: console.append(f"pageerror: {e}"[:300]))
        if polyfill:
            page.add_init_script(path=polyfill)
        page.goto(url, wait_until="networkidle", timeout=30000)
        page.wait_for_timeout(1500)
        info = page.evaluate(INSPECT)
        info["launch_args"] = launch_args
        info["polyfill"] = bool(polyfill)
        print(json.dumps(info, ensure_ascii=False))
        if "--call" in args:
            print(json.dumps(page.evaluate(CALL), ensure_ascii=False)[:3000])
        if console:
            print(json.dumps({"console": console[-10:]}, ensure_ascii=False))
        b.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
