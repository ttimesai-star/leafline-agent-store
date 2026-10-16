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
    if l.get("gemini_api_key_2"):
        pairs["GEMINI_API_KEY"] = l["gemini_api_key_2"]
        pairs["GEMINI_MODEL"] = "gemini-3-flash-preview"
    if l.get("groq_api_key"):
        pairs["GROQ_API_KEY"] = l["groq_api_key"]
except (OSError, ValueError):
    pass
for k, v in pairs.items():
    print(f"export {k}={shlex.quote(v)}")
PY
)"
exec "$@"
