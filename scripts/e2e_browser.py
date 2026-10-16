"""Browser end-to-end check against a running store (local or deployed), PayPal SANDBOX only.

Usage: scripts/with-sandbox-env.sh python scripts/e2e_browser.py [--url http://localhost:8787] [--headed]
         [--only human|agent|claims|mcp] [--flags]

Steps (each prints PASS/FAIL with a short reason, screenshots go to data/e2e/):
  human  - add two products to the cart, pay with the PayPal JS SDK v6 button (popup), sandbox buyer approves,
           store captures, order page shows COMPLETED.
  agent  - delegate a budget (mandate), run the in-page agent ("green tea and a mug"), agent order appears,
           buyer approves it with the PayPal button, order page shows COMPLETED with the agent receipt; then an
           over-budget agent order is refused.
  claims - on the agent order page the buyer reports a problem; merchant panel shows the DisputeDesk case with
           agent evidence; merchant refunds through PayPal (sandbox refund via the PayPal Agent Toolkit) -> REFUNDED.
  mcp    - an external agent (official MCP SDK client, scripts/mcp_client.ts) connects to {url}/mcp with a buyer
           mandate, orders within it, the buyer approves the approveUrl in PayPal, the order is COMPLETED; an
           over-budget order from the same agent is refused by the store.
Reads PAYPAL_BUYER_EMAIL / PAYPAL_BUYER_PASSWORD (and MERCHANT_KEY when the server has one) from env; never prints them.
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from urllib.parse import urlparse, quote

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

ARGS = sys.argv[1:]
URL = (ARGS[ARGS.index("--url") + 1] if "--url" in ARGS else "http://localhost:8787").rstrip("/")
ONLY = ARGS[ARGS.index("--only") + 1] if "--only" in ARGS else None
SHOTS = os.path.join(os.path.dirname(__file__), "..", "data", "e2e")
EMAIL = os.environ.get("PAYPAL_BUYER_EMAIL", "")
PASSWORD = os.environ.get("PAYPAL_BUYER_PASSWORD", "")
# Server started with MERCHANT_KEY: the panel gets it through the URL fragment (never sent to the server),
# direct API reads send it as X-Merchant-Key.
MERCHANT_KEY = os.environ.get("MERCHANT_KEY", "")
KEY_FRAG = f"#key={quote(MERCHANT_KEY, safe='')}" if MERCHANT_KEY else ""
results = []


def log(step, ok, msg=""):
    results.append((step, ok))
    print(f"{'PASS' if ok else 'FAIL'} {step}: {msg}", flush=True)


def shot(page, name):
    os.makedirs(SHOTS, exist_ok=True)
    # Viewport only: a full-page screenshot resizes the viewport and makes the PayPal SDK button re-render.
    page.screenshot(path=os.path.join(SHOTS, f"{name}.png"))


PAY_BTN = (
    "#payment-submit-btn, button[data-id='payment-submit-btn'], button:has-text('Complete Purchase'), "
    "button:has-text('Pay Now'), button:has-text('Continue to Review Order'), button:has-text('Continue')"
)
# Which screen the PayPal popup shows right now: login email, password, review (pay button) or the sandbox error page.
# Visibility is judged by the rendered box: on the split login page PayPal keeps #password in the layout
# (offsetParent set) while only the email step is on screen, and an empty visible email field wins.
STATE_JS = """() => {
  const vis = (el) => {
    if (!el || el.offsetParent === null) return false;
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && Number(cs.opacity) > 0;
  };
  if (/Things don.t appear to be working/i.test(document.body?.innerText || '')) return 'error';
  if ([...document.querySelectorAll('button')].some(b => vis(b) && /Complete Purchase|Pay Now|Continue/.test(b.textContent))) return 'pay';
  const email = document.querySelector('#email');
  if (vis(email) && !email.value) return 'email';
  if (vis(document.querySelector('#password')) && vis(document.querySelector('#btnLogin'))) return 'password';
  if (vis(email)) return 'email';
  return '';
}"""


def approve_in_popup(popup):
    """Sandbox buyer login + approve inside the PayPal popup opened by the JS SDK.
    Handles an already logged-in context and the sandbox's intermittent error page (each retry is reported)."""
    # The SDK opens about:blank first (inside the click's user activation), then navigates to PayPal.
    popup.wait_for_url(lambda u: "paypal.com" in u, timeout=60000)
    popup.wait_for_load_state("domcontentloaded", timeout=60000)
    host = urlparse(popup.url).hostname or ""
    if "sandbox.paypal.com" not in host:
        raise RuntimeError(f"popup is not the PayPal sandbox: {host}")
    errors_seen = 0
    trace = []
    for _ in range(10):
        popup.wait_for_function(f"() => ({STATE_JS})() !== ''", timeout=60000)
        state = popup.evaluate(STATE_JS)
        trace.append(state)
        try:
            if state == "error":
                errors_seen += 1
                if errors_seen > 2:
                    raise RuntimeError("PayPal sandbox error page persisted after 2 retries")
                print("NOTE popup: PayPal sandbox error page, pressing 'Try again'", flush=True)
                popup.get_by_text("Try again").first.click(timeout=15000)
                popup.wait_for_timeout(3000)
            elif state == "email":
                popup.locator("#email").fill(EMAIL, timeout=15000)
                nxt = popup.locator("#btnNext")
                if nxt.is_visible():
                    nxt.click(timeout=15000)
                popup.wait_for_timeout(1500)
            elif state == "password":
                popup.locator("#password").fill(PASSWORD, timeout=15000)
                popup.locator("#btnLogin").click(timeout=15000)
                popup.wait_for_timeout(3000)
            elif state == "pay":
                popup.wait_for_timeout(1500)
                popup.locator(PAY_BTN).first.click(timeout=15000)
                return
        except PWTimeout as e:
            # The page moved on under us (e.g. turned into the error page); re-read the state.
            trace.append("timeout:" + str(e).splitlines()[0][:60])
            popup.wait_for_timeout(1000)
    raise RuntimeError("PayPal popup did not reach the pay button in 10 steps: " + " > ".join(trace))


def open_popup(page, selector, name):
    """Click the v6 PayPal button and return the popup. A click right after the button appears sometimes opens
    nothing (no error, no console message); one retry is allowed and reported, never hidden."""
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(1500)
    for attempt in (1, 2):
        try:
            with page.context.expect_page(timeout=20000) as pop:
                page.locator(selector).click()
            if attempt == 2:
                print(f"NOTE {name}: PayPal popup opened after the reload", flush=True)
            return pop.value
        except PWTimeout:
            if attempt == 2:
                raise
            shot(page, f"{name}_no_popup")
            # Seen ~1 in 10 runs: the SDK never calls window.open and a second click on the same page does
            # nothing either. Reload (cart and agent order live in storage) and click again.
            print(f"NOTE {name}: no popup after the first click, reloading the page and retrying once", flush=True)
            page.reload(wait_until="networkidle")
            page.wait_for_selector(f"{selector}:not([hidden])", timeout=30000)
            page.wait_for_timeout(1500)


def pay_with_button(page, selector, name):
    popup = open_popup(page, selector, name)
    try:
        approve_in_popup(popup)
    except Exception:
        try:
            shot(popup, f"{name}_popup_fail")
        except Exception:
            pass
        raise
    page.wait_for_url(re.compile(r"/order\?id="), timeout=90000)
    page.wait_for_selector("#summary .status", timeout=30000)
    page.wait_for_timeout(800)


def human(page):
    page.goto(URL + "/", wait_until="networkidle")
    page.wait_for_selector("#products .card", timeout=20000)
    n = page.locator("#products .card").count()
    badge = page.locator("#webmcp-badge").inner_text()
    log("store renders", n >= 6, f"{n} products, badge '{badge}'")
    shot(page, "01_store")
    page.locator("button[data-add='TEA-SENCHA-80']").click()
    page.locator("button[data-add='MUG-STONE-350']").click()
    page.wait_for_selector("#cart-pay:not([hidden])", timeout=30000)
    log("v6 PayPal button shown", True, page.locator("#cart-total").inner_text())
    shot(page, "02_cart")
    pay_with_button(page, "#cart-pay", "human")
    status = page.locator("#summary .status").inner_text()
    oid = page.locator("#oid").inner_text()
    log("human order paid via JS SDK v6 popup", status == "COMPLETED", f"order {oid} {status}")
    shot(page, "03_human_order")
    return oid


def agent(page):
    page.goto(URL + "/", wait_until="networkidle")
    page.wait_for_selector("#products .card", timeout=20000)
    if page.locator("#m-create").is_visible():
        page.fill("#m-budget", "40")
        page.fill("#m-per", "")
        page.locator("#m-create").click()
    page.wait_for_selector("#mandate-view .mandate", timeout=15000)
    log("mandate delegated", True, page.locator("#mandate-view").inner_text().splitlines()[0])
    page.fill("#task", "Buy green tea and a mug")
    page.locator("#run-agent").click()
    page.wait_for_selector("#agent-order:not([hidden])", timeout=120000)
    planner = page.locator("#planner-note").inner_text()
    feed = page.locator("#feed").inner_text()
    tools_used = re.findall(r"\b(get_budget|search_products|create_order)\b", feed)
    log("agent created order via WebMCP", "create_order" in tools_used, f"{planner} tools={sorted(set(tools_used))}")
    shot(page, "04_agent_cart")
    page.wait_for_selector("#agent-pay:not([hidden])", timeout=30000)
    pay_with_button(page, "#agent-pay", "agent")
    status = page.locator("#summary .status").inner_text()
    oid = page.locator("#oid").inner_text()
    receipt = page.locator("#receipt li").count()
    log("agent order approved by buyer and captured", status == "COMPLETED" and receipt >= 3, f"order {oid} {status}, receipt {receipt} calls")
    shot(page, "05_agent_order")
    # Over-budget attempt is refused by the server (not just by the agent).
    r = page.evaluate(
        """async () => {
        const m = sessionStorage.getItem('leafline.mandate');
        const s = sessionStorage.getItem('leafline.session');
        const res = await fetch('/api/orders', {method: 'POST', headers: {'content-type': 'application/json', 'x-agent-tool': 'create_order', 'x-agent-session': s, 'x-agent-mandate': m}, body: JSON.stringify({items: [{sku: 'KETTLE-GOOSE-1L', quantity: 1}]})});
        return [res.status, (await res.json()).code];
    }"""
    )
    log("over-budget agent order refused", r[0] == 403 and r[1] == "OVER_BUDGET", str(r))
    return oid


def claims(page, oid):
    page.goto(f"{URL}/order?id={oid}", wait_until="networkidle")
    page.wait_for_selector("#claim-form:not([hidden])", timeout=20000)
    page.select_option("#c-kind", "DISPUTE")
    page.select_option("#c-reason", "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED")
    page.fill("#c-note", "The tea tastes stale, not as described.")
    page.locator("#c-send").click()
    page.wait_for_selector("#claims .notice", timeout=20000)
    log("buyer opened a claim", "OPEN" in page.locator("#claims").inner_text(), page.locator("#claims").inner_text()[:80])
    page.goto(URL + "/merchant?tab=cases" + KEY_FRAG, wait_until="networkidle")
    page.wait_for_selector("#g-cases .ag-row", timeout=30000)
    page.locator("#g-cases .ag-row").first.click()
    page.wait_for_selector("#case .rec", timeout=10000)
    detail = page.locator("#case").inner_text()
    log("DisputeDesk case with agent evidence", "from the agent journal" in detail, detail.splitlines()[0][:80])
    shot(page, "06_merchant_case")
    if page.locator("#do-refund").count():
        page.locator("#do-refund").click()
        page.wait_for_selector("#msg .notice", timeout=60000)
        msg = page.locator("#msg").inner_text()
        log("merchant refund via PayPal", "REFUNDED" in msg, msg[:100])
    kit_req = urllib.request.Request(URL + "/api/merchant/toolkit", headers={"x-merchant-key": MERCHANT_KEY} if MERCHANT_KEY else {})
    kit = json.loads(urllib.request.urlopen(kit_req, timeout=30).read())
    refunds = [c for c in kit.get("calls", []) if c.get("tool") == "create_refund"]
    log("refund issued through PayPal Agent Toolkit", bool(refunds) and refunds[0].get("ok") is True,
        f"{(kit.get('toolkit') or {}).get('package')} {(kit.get('toolkit') or {}).get('version')}, create_refund ok={refunds[0].get('ok') if refunds else None}")
    page.locator(".tabs button[data-tab='toolkit']").click()
    page.wait_for_timeout(500)
    shot(page, "09_merchant_toolkit")
    page.locator(".tabs button[data-tab='orders']").click()
    page.wait_for_timeout(500)
    shot(page, "07_merchant_orders")
    page.locator(".tabs button[data-tab='journal']").click()
    page.wait_for_timeout(500)
    shot(page, "08_merchant_journal")


HERE = os.path.dirname(os.path.abspath(__file__))


def mcp_call(mandate, *args):
    out = subprocess.run(["node", os.path.join(HERE, "mcp_client.ts"), "--url", URL, "--mandate", mandate, *args],
                         capture_output=True, text=True, timeout=120)
    if out.returncode != 0:
        raise RuntimeError(f"mcp_client failed: {out.stderr.strip()[:200]}")
    return json.loads(out.stdout.strip().splitlines()[-1])


def mcp(page):
    req = urllib.request.Request(URL + "/api/mandates", data=json.dumps({"budget": 20, "per_order_max": 15}).encode(),
                                 headers={"content-type": "application/json"}, method="POST")
    mandate = json.loads(urllib.request.urlopen(req, timeout=30).read())["mandateId"]
    tools = mcp_call(mandate, "tools")["tools"]
    log("external MCP agent sees the store tools", len(tools) == 6, ",".join(tools))
    budget = mcp_call(mandate, "call", "get_budget", "{}")["result"]
    order = mcp_call(mandate, "call", "create_order", json.dumps({"items": [{"sku": "TEA-SENCHA-80", "quantity": 1}]}))
    res = order["result"]
    ok = not order["isError"] and res.get("approveUrl", "").startswith("https://www.sandbox.paypal.com/")
    log("MCP agent order inside the mandate", ok, f"budget {budget.get('remaining')} -> order {res.get('orderId')} {res.get('total')}, remaining {(res.get('mandate') or {}).get('remaining')}")
    if not ok:
        return
    page.goto(res["approveUrl"], wait_until="domcontentloaded")
    approve_in_popup(page)
    page.wait_for_url(re.compile(r"/order\?id="), timeout=90000)
    page.wait_for_selector("#summary .status", timeout=30000)
    page.wait_for_timeout(800)
    shot(page, "10_mcp_order")
    status = mcp_call(mandate, "call", "get_order_status", json.dumps({"order_id": res["orderId"]}))["result"]
    log("buyer approved MCP agent order in PayPal, captured", status.get("status") == "COMPLETED", f"order {res['orderId']} {status.get('status')} capture {status.get('captureId')}")
    over = mcp_call(mandate, "call", "create_order", json.dumps({"items": [{"sku": "TEA-OOLONG-100", "quantity": 1}]}))
    log("over-budget MCP agent order refused", over["isError"] and over["result"].get("code") == "OVER_BUDGET", str(over["result"])[:120])


def main():
    if not EMAIL or not PASSWORD:
        print("buyer credentials missing in env (run via scripts/with-sandbox-env.sh)")
        return 2
    launch_args = ["--enable-features=WebMCP,WebMCPTesting"] if "--flags" in ARGS else []
    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", headless="--headed" not in ARGS, args=launch_args)
        ctx = b.new_context(viewport={"width": 1366, "height": 900}, locale="en-US")
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)[:200]))
        page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}"[:200]) if m.type in ("error", "warning") else None)
        try:
            if ONLY in (None, "human"):
                human(page)
            oid = None
            if ONLY in (None, "agent", "claims"):
                oid = agent(page)
            if ONLY in (None, "claims") and oid:
                claims(page, oid)
            if ONLY in (None, "mcp"):
                mcp(page)
        except (PWTimeout, RuntimeError) as e:
            log("unexpected", False, str(e).splitlines()[0][:200])
            try:
                print("cart-msg:", page.locator("#cart-msg").inner_text()[:200])
            except Exception:
                pass
            shot(page, "99_fail")
        if errors:
            print(json.dumps({"page_errors": errors[-5:]}))
        b.close()
    failed = [s for s, ok in results if not ok]
    print(f"SUMMARY {len(results) - len(failed)}/{len(results)} passed" + (f"; failed: {failed}" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
