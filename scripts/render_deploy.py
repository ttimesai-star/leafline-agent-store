"""Deploy the public demo on Render and verify the live version equals the local HEAD.

The public GitHub repo is not connected through Render's GitHub app, so a push does not deploy by itself:
this script triggers the deploy through the Render API, waits for it, then compares /api/health "version"
with `git rev-parse --short HEAD`.

Usage: python scripts/render_deploy.py [--service srv-...] [--url https://...]
Reads RENDER_API_KEY from env, or ~/.claude/secrets/render_ttimesai.json; service id and URL default to
~/.claude/secrets/leafline_render.json. Never prints the key.
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

HOME_SECRETS = os.path.expanduser("~/.claude/secrets/")
ARGS = sys.argv[1:]


def arg(name, default=None):
    return ARGS[ARGS.index(name) + 1] if name in ARGS else default


def load(name):
    try:
        return json.load(open(HOME_SECRETS + name, encoding="utf-8"))
    except OSError:
        return {}


KEY = os.environ.get("RENDER_API_KEY") or load("render_ttimesai.json").get("api_key", "")
STATE = load("leafline_render.json")
SERVICE = arg("--service", STATE.get("service_id"))
URL = arg("--url", STATE.get("url", "")).rstrip("/")


def api(method, path, body=None):
    req = urllib.request.Request("https://api.render.com/v1" + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {KEY}", "Accept": "application/json", "Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=60).read())


def main():
    if not KEY or not SERVICE or not URL:
        print("missing Render key, service id or URL")
        return 2
    head = subprocess.run(["git", "rev-parse", "--short=7", "HEAD"], capture_output=True, text=True,
                          cwd=os.path.dirname(os.path.abspath(__file__))).stdout.strip()
    dep = api("POST", f"/services/{SERVICE}/deploys", {"clearCache": "do_not_clear"})
    print(f"deploy {dep.get('id')} for commit {dep.get('commit', {}).get('id', '')[:7]} (local HEAD {head})", flush=True)
    t0, status = time.time(), ""
    while time.time() - t0 < 900:
        d = api("GET", f"/services/{SERVICE}/deploys/{dep['id']}")
        if d["status"] != status:
            status = d["status"]
            print(f"{int(time.time() - t0)} s {status}", flush=True)
        if status in ("live", "build_failed", "update_failed", "canceled", "deactivated", "pre_deploy_failed"):
            break
        time.sleep(15)
    if status != "live":
        print("deploy did not go live")
        return 1
    live = json.loads(urllib.request.urlopen(URL + "/api/health", timeout=90).read()).get("version")
    print(f"live version {live}, local HEAD {head}: {'OK' if live == head else 'MISMATCH (push first?)'}")
    return 0 if live == head else 1


if __name__ == "__main__":
    sys.exit(main())
