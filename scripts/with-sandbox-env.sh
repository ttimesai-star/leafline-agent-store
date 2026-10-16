#!/usr/bin/env bash
# Usage: scripts/with-sandbox-env.sh <command...>
# Exports sandbox credentials from ~/.claude/secrets/paypal_sandbox.json into env (never printed),
# then runs the command. The secrets file stays outside the repo.
set -euo pipefail
SECRETS="${PAYPAL_SECRETS_FILE:-$HOME/.claude/secrets/paypal_sandbox.json}"
eval "$(python - "$SECRETS" <<'PY'
import json, shlex, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
# Prefer the US sandbox set (BY accounts cannot complete payments); fall back to legacy BY fields.
app = d.get("us_business_app") or d
accounts = d.get("sandbox_accounts_us") or d.get("sandbox_accounts", [])
buyer = next((a for a in accounts if a.get("role") == "buyer"), {})
pairs = {
    "PAYPAL_CLIENT_ID": app["client_id"],
    "PAYPAL_CLIENT_SECRET": app["secret"],
    "PAYPAL_API_BASE": app.get("api_base", "https://api-m.sandbox.paypal.com"),
    "PAYPAL_BUYER_EMAIL": buyer.get("email", ""),
    "PAYPAL_BUYER_PASSWORD": buyer.get("password", ""),
}
# Optional LLM keys for the in-page agent planner (free tiers). Missing file or keys -> rule-based planner.
import os
llm_file = os.environ.get("LLM_SECRETS_FILE", os.path.expanduser("~/.claude/secrets/meta_aittimes_app.json"))
try:
    l = json.load(open(llm_file, encoding="utf-8"))
    gem = [l[k] for k in ("gemini_api_key_3", "gemini_api_key_4", "gemini_api_key_5", "gemini_api_key_6", "gemini_api_key_2") if l.get(k)]
    if gem:
        pairs["GEMINI_API_KEY"] = ",".join(gem)
        pairs["GEMINI_MODEL"] = "gemini-3-flash-preview"
    if l.get("mistral_api_key"):
        pairs["MISTRAL_API_KEY"] = l["mistral_api_key"]
except (OSError, ValueError):
    pass
# AG Studio trial licence (front-end key; kept out of git, injected into the merchant page via /api/config).
ag_file = os.environ.get("AG_SECRETS_FILE", os.path.expanduser("~/.claude/secrets/ag_grid_trial.json"))
try:
    keys = json.load(open(ag_file, encoding="utf-8")).get("keys", {})
    studio = next((k["key"] for k in keys.values() if "studio" in str(k.get("product", "")).lower()), "")
    if studio:
        pairs["AG_STUDIO_LICENSE_KEY"] = studio
except (OSError, ValueError):
    pass
for k, v in pairs.items():
    print(f"export {k}={shlex.quote(v)}")
PY
)"
exec "$@"
