"""Record the demo video from the live store (PayPal SANDBOX): one continuous browser run with scene marks,
synthesized narration per scene (edge-tts, no human voice), assembled with ffmpeg so each scene's footage is sped
up or held on its last frame to its narration length. Script text: inbox video_script.md (kept in sync here).

Usage: scripts/with-sandbox-env.sh python scripts/record_demo.py --url https://leafline-agent-store.onrender.com
       [--out data/video] [--voice en-US-AndrewNeural] [--skip-record]
Needs MERCHANT_KEY in env for the refund scene (never shown: it goes into the URL fragment, the address bar is
not recorded). Buyer sandbox credentials come from env as in e2e_browser.py.
"""
import asyncio
import json
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import e2e_browser as e2e  # noqa: E402  (reuses the sandbox approval helpers; parses --url itself)

from playwright.sync_api import sync_playwright  # noqa: E402

ARGS = sys.argv[1:]
OUT = os.path.abspath(ARGS[ARGS.index("--out") + 1] if "--out" in ARGS else os.path.join(HERE, "..", "data", "video"))
VOICE = ARGS[ARGS.index("--voice") + 1] if "--voice" in ARGS else "en-US-AndrewNeural"
URL = e2e.URL
KEY_FRAG = e2e.KEY_FRAG

SCENES = [
    ("intro", "AI agents are starting to shop for people. Most of them still click through web pages built for humans. Leafline is a small tea shop on PayPal that is ready for them, and keeps the buyer in control."),
    ("mandate", "First, the buyer delegates a spending mandate: a total budget, a cap per order, allowed categories and an expiry. The store server checks every agent order against it, before a PayPal order even exists."),
    ("agent", "The agent does not scrape the page. The store publishes six tools through WebMCP, and the agent, here Gemini 3 Flash, calls them directly: search, check the budget, create the order. A handful of calls instead of dozens of clicks."),
    ("approve", "The agent can create an order, but it can never pay. The buyer approves the payment in PayPal, and only the merchant's server captures it. The order page keeps the agent receipt: every call that led to this purchase."),
    ("refusal", "Ask for more than the mandate allows. A well-behaved agent reads its budget and stops by itself. One that tries anyway is refused by the store, as the next scene shows."),
    ("mcp", "Agents outside the browser get the same six tools over MCP, with the same mandate checks and the same journal. This external client's second order went over its budget, and the server refused it with a reason. No PayPal order, no charge."),
    ("dispute", "When the buyer says it is not what they ordered, the merchant sees a DisputeDesk case built from the agent receipt: what the agent was shown, what the buyer delegated, who approved the payment. The refund goes through the PayPal Agent Toolkit."),
    ("analytics", "The merchant dashboard, built on AG Studio, shows how much revenue comes from agents, what the mandates stopped, and which claims are worth fighting. One click filters the whole page to agent orders."),
    ("dashtools", "And the dashboard is agent-readable too. Its read-only tools are published over WebMCP, so the merchant's own agent can ask it questions, like allowed versus refused calls by tool, instead of reading charts."),
    ("outro", "Leafline is an open-source prototype running in the PayPal sandbox. Agents get structured tools, buyers keep the final say, and merchants get the evidence."),
]

CLICK_RING = """document.addEventListener('mousedown', (e) => {
  const d = document.createElement('div');
  d.style.cssText = `position:fixed;left:${e.clientX - 18}px;top:${e.clientY - 18}px;width:36px;height:36px;border:3px solid #2f6b4f;` +
    'border-radius:50%;pointer-events:none;z-index:2147483647;transition:transform .6s,opacity .6s;opacity:.9';
  document.documentElement.appendChild(d);
  requestAnimationFrame(() => { d.style.transform = 'scale(1.8)'; d.style.opacity = '0'; });
  setTimeout(() => d.remove(), 700);
}, true);"""

TITLE_HTML = """<html><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
background:#f5f6f4;font-family:system-ui,Segoe UI,sans-serif;color:#1d2a22"><div style="text-align:center">
<div style="font-size:54px;font-weight:700;color:#2f6b4f">Leafline</div>
<div style="font-size:26px;margin-top:10px">an agent-ready storefront on PayPal</div>
<div style="font-size:20px;margin-top:34px">leafline-agent-store.onrender.com</div>
<div style="font-size:20px;margin-top:8px">github.com/ttimesai-star/leafline-agent-store</div>
<div style="font-size:16px;margin-top:30px;color:#6b756f">PayPal sandbox prototype - open source (MIT) - not audited</div>
</div></body></html>"""


def record():
    marks = []
    os.makedirs(OUT, exist_ok=True)
    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", args=["--enable-features=WebMCP,WebMCPTesting"])
        ctx = b.new_context(viewport={"width": 1536, "height": 864}, record_video_dir=OUT, record_video_size={"width": 1536, "height": 864}, locale="en-US")
        # The recording has no mouse cursor: draw a short-lived ring where each click lands.
        ctx.add_init_script(CLICK_RING)
        page = ctx.new_page()
        t0 = time.monotonic()
        mark = lambda name: marks.append((name, round(time.monotonic() - t0, 2)))  # noqa: E731

        # warm the free instance off-camera is not possible inside one recording; the caller warms it first
        mark("intro")
        page.goto(URL + "/", wait_until="networkidle")
        page.wait_for_selector("#products .card", timeout=60000)
        page.wait_for_timeout(5000)

        mark("mandate")
        page.locator("#m-budget").scroll_into_view_if_needed()
        page.fill("#m-budget", "")
        page.type("#m-budget", "40", delay=120)
        page.wait_for_timeout(600)
        page.type("#m-per", "35", delay=120)
        page.wait_for_timeout(600)
        coffee = page.locator("#m-cats input[value='coffee']")
        if coffee.is_checked():
            coffee.uncheck()
        page.wait_for_timeout(800)
        page.locator("#m-create").click()
        page.wait_for_selector("#mandate-view .mandate", timeout=20000)
        page.wait_for_timeout(3500)

        mark("agent")
        page.fill("#task", "")
        page.type("#task", "Buy green tea and a mug", delay=45)
        page.wait_for_timeout(800)
        page.locator("#run-agent").click()
        page.wait_for_selector("#agent-order:not([hidden])", timeout=120000)
        page.locator("#feed").scroll_into_view_if_needed()
        planner = page.locator("#planner-note").inner_text()
        page.wait_for_timeout(3500)

        mark("approve")
        href = page.locator("#agent-pay-link").get_attribute("href")
        # PayPal picks the login language from the IP; ask for English explicitly.
        page.goto(href + ("&" if "?" in href else "?") + "locale.x=en_US", wait_until="domcontentloaded")
        e2e.approve_in_popup(page)
        page.wait_for_url(re.compile(r"/order\?id="), timeout=90000)
        page.wait_for_selector("#summary .status", timeout=30000)
        oid = page.locator("#oid").inner_text()
        page.wait_for_timeout(4000)
        page.locator("#receipt").scroll_into_view_if_needed()
        page.wait_for_timeout(4000)

        mark("refusal")
        page.goto(URL + "/", wait_until="networkidle")
        page.fill("#task", "Buy a gooseneck kettle and matcha")
        before = page.locator("#feed li").count()
        page.locator("#run-agent").click()
        # Done when a new final agent message is on top (the LLM agent usually declines after get_budget; a
        # create_order attempt would be refused by the server instead - either outcome is shown as it happens).
        page.wait_for_function(f"() => document.querySelectorAll('#feed li').length > {before} + 1 && /^Agent:/.test(document.querySelector('#feed li')?.innerText || '')", timeout=120000)
        page.locator("#feed").scroll_into_view_if_needed()
        page.wait_for_timeout(3000)

        # external MCP agent, off-camera: a fresh mandate, one order inside it, one refused
        req = json.dumps({"budget": 20, "per_order_max": 15}).encode()
        import urllib.request
        m = json.loads(urllib.request.urlopen(urllib.request.Request(URL + "/api/mandates", data=req, headers={"content-type": "application/json"}, method="POST"), timeout=60).read())["mandateId"]
        e2e.mcp_call(m, "call", "create_order", json.dumps({"items": [{"sku": "TEA-SENCHA-80", "quantity": 1}]}))
        e2e.mcp_call(m, "call", "create_order", json.dumps({"items": [{"sku": "TEA-OOLONG-100", "quantity": 1}]}))
        mark("mcp")
        page.goto(URL + "/merchant?tab=journal" + KEY_FRAG, wait_until="networkidle")
        page.wait_for_selector("#g-journal .ag-row", timeout=60000)
        page.wait_for_timeout(5000)

        mark("dispute")
        page.goto(f"{URL}/order?id={oid}", wait_until="networkidle")
        page.wait_for_selector("#claim-form:not([hidden])", timeout=30000)
        page.locator("#claim-form").scroll_into_view_if_needed()
        page.select_option("#c-kind", "DISPUTE")
        page.select_option("#c-reason", "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED")
        page.fill("#c-note", "The tea tastes stale, not as described.")
        page.locator("#c-send").click()
        page.wait_for_selector("#claims .notice", timeout=30000)
        page.wait_for_timeout(1200)
        # Open the panel on Analytics first so AG Studio loads now (off the analytics scene), then go to Disputes.
        page.goto(URL + "/merchant" + KEY_FRAG, wait_until="networkidle")
        page.locator(".tabs button[data-tab='cases']").click()
        page.wait_for_selector("#g-cases .ag-row", timeout=60000)
        page.locator("#g-cases .ag-row").first.click()
        page.wait_for_selector("#case .rec", timeout=20000)
        page.wait_for_timeout(3000)
        if page.locator("#do-refund").count():
            page.locator("#do-refund").scroll_into_view_if_needed()
            page.locator("#do-refund").click()
            page.wait_for_selector("#msg .notice", timeout=90000)
            page.locator("#msg").scroll_into_view_if_needed()
        page.wait_for_timeout(2500)

        mark("analytics")
        page.locator(".tabs button[data-tab='analytics']").click()
        page.wait_for_function("() => { const t = document.querySelector('#studio')?.innerText || ''; return t.includes('Net revenue') && !t.includes('Loading'); }", timeout=90000)
        page.evaluate("() => window.scrollTo(0, document.querySelector('#studio').getBoundingClientRect().top + window.scrollY - 40)")
        page.wait_for_timeout(4000)
        page.get_by_text("AI agent", exact=True).first.click()
        page.wait_for_timeout(4000)
        page.get_by_text("AI agent", exact=True).first.click()
        page.wait_for_timeout(2500)

        mark("dashtools")
        page.locator("#studio-ask").scroll_into_view_if_needed()
        page.locator("#studio-ask").click()
        page.wait_for_selector("#studio-answer table", timeout=30000)
        page.locator("#studio-answer").scroll_into_view_if_needed()
        page.wait_for_timeout(5000)

        mark("outro")
        page.set_content(TITLE_HTML)
        page.wait_for_timeout(6000)
        mark("end")
        video = page.video.path()
        ctx.close()
        b.close()
    meta = {"video": video, "marks": marks, "planner": planner, "order": oid}
    json.dump(meta, open(os.path.join(OUT, "marks.json"), "w"), indent=1)
    print(json.dumps(meta, indent=1))
    return meta


async def tts_all():
    import edge_tts
    for name, text in SCENES:
        out = os.path.join(OUT, f"n_{name}.mp3")
        await edge_tts.Communicate(text, VOICE, rate="+4%").save(out)


def dur(path):
    return float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], capture_output=True, text=True).stdout.strip())


def assemble(meta):
    marks = dict(meta["marks"])
    order = [n for n, _ in SCENES] + ["end"]
    parts = []
    for i, (name, _) in enumerate(SCENES):
        start, end = marks[name], marks[order[i + 1]]
        seg = max(end - start, 0.5)
        narr = os.path.join(OUT, f"n_{name}.mp3")
        target = dur(narr) + 0.7
        speed = seg / target
        vf = f"trim=start={start}:end={end},setpts=PTS-STARTPTS"
        vf += f",setpts=PTS/{speed:.4f}" if speed > 1 else f",tpad=stop_mode=clone:stop_duration={target - seg:.3f}"
        vf += ",scale=1920:1080:flags=lanczos,fps=30,format=yuv420p"  # recorded at 1536x864 (larger UI), delivered 1080p
        part = os.path.join(OUT, f"p_{i:02d}_{name}.mp4")
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", meta["video"], "-i", narr, "-filter_complex",
                        f"[0:v]{vf}[v];[1:a]apad=whole_dur={target:.3f},aresample=48000[a]", "-map", "[v]", "-map", "[a]",
                        "-t", f"{target:.3f}", "-c:v", "libx264", "-crf", "20", "-preset", "medium", "-c:a", "aac", "-b:a", "160k", part], check=True)
        parts.append(part)
        print(f"{name}: footage {seg:.1f}s -> {target:.1f}s ({'x%.2f' % speed if speed > 1 else 'hold'})")
    lst = os.path.join(OUT, "parts.txt")
    open(lst, "w").write("".join(f"file '{p.replace(os.sep, '/')}'\n" for p in parts))
    final = os.path.join(OUT, "leafline_demo.mp4")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", "-movflags", "+faststart", final], check=True)
    print("final:", final, f"{dur(final):.1f}s")
    return final


def main():
    if "--skip-record" in ARGS:
        meta = json.load(open(os.path.join(OUT, "marks.json")))
    else:
        if not e2e.EMAIL or not e2e.PASSWORD or not e2e.MERCHANT_KEY:
            print("needs sandbox buyer credentials and MERCHANT_KEY in env")
            return 2
        meta = record()
    asyncio.run(tts_all())
    final = assemble(meta)
    if dur(final) >= 180:
        print("TOO LONG for the 3-minute limit")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
