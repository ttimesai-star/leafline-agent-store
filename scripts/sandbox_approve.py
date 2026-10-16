"""Approve a PayPal SANDBOX order as the sandbox buyer (test helper, not product code).

Usage: scripts/with-sandbox-env.sh python scripts/sandbox_approve.py <approve_url> [--headed]
Reads PAYPAL_BUYER_EMAIL / PAYPAL_BUYER_PASSWORD from env. Refuses non-sandbox URLs.
Prints only step names and the final URL host/path (no credentials).
"""
import os
import sys
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright, Error as PWError, TimeoutError as PWTimeout

SHOT_DIR = os.environ.get("SPIKE_SHOT_DIR", "data")


def log(msg: str) -> None:
    print(msg, flush=True)


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    url = sys.argv[1]
    headed = "--headed" in sys.argv
    u = urlparse(url)
    if u.scheme != "https" or u.hostname != "www.sandbox.paypal.com":
        log("refusing: not a sandbox approve URL")
        return 2
    email = os.environ.get("PAYPAL_BUYER_EMAIL")
    password = os.environ.get("PAYPAL_BUYER_PASSWORD")
    if not email or not password:
        log("buyer credentials missing in env")
        return 2
    os.makedirs(SHOT_DIR, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=not headed)
        page = browser.new_page()
        page.goto(url, wait_until="domcontentloaded", timeout=60000)
        try:
            page.locator("#email").fill(email, timeout=30000)
            log("email filled")
            nxt = page.locator("#btnNext")
            if nxt.is_visible():
                nxt.click()
                log("next clicked")
            page.locator("#password").fill(password, timeout=30000)
            page.locator("#btnLogin").click()
            log("login clicked")
            btn = page.locator(
                "#payment-submit-btn, button[data-id='payment-submit-btn'], button:has-text('Complete Purchase'), "
                "button:has-text('Continue to Review Order'), button:has-text('Pay Now'), button:has-text('Continue')"
            ).first
            btn.wait_for(state="visible", timeout=60000)
            page.wait_for_timeout(1500)
            btn.click()
            log("approve clicked")
            try:
                page.wait_for_url(lambda s: "localhost" in s or "paypal/return" in s, timeout=60000)
            except PWError as e:
                # Return URL points at a local server that may not be running: connection refused
                # AFTER the redirect still means PayPal approved the order. Verify via GET order.
                if "ERR_CONNECTION_REFUSED" not in str(e):
                    raise
                log("return URL refused (server not running) - approval done on PayPal side")
                return 0
            fu = urlparse(page.url)
            log(f"redirected to {fu.hostname}{fu.path}")
            return 0
        except PWTimeout as e:
            page.screenshot(path=os.path.join(SHOT_DIR, "approve_fail.png"))
            fu = urlparse(page.url)
            log(f"timeout at {fu.hostname}{fu.path}: {str(e).splitlines()[0]}")
            return 1
        finally:
            browser.close()


if __name__ == "__main__":
    sys.exit(main())
