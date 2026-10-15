#!/usr/bin/env bash
# Usage: scripts/with-sandbox-env.sh <command...>
# Exports sandbox credentials from ~/.claude/secrets/paypal_sandbox.json into env (never printed),
# then runs the command. The secrets file stays outside the repo.
set -euo pipefail
SECRETS="${PAYPAL_SECRETS_FILE:-$HOME/.claude/secrets/paypal_sandbox.json}"
eval "$(python - "$SECRETS" <<'PY'
import json, shlex, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
buyer = next((a for a in d.get("sandbox_accounts", []) if a.get("role") == "buyer"), {})
pairs = {
    "PAYPAL_CLIENT_ID": d["client_id"],
    "PAYPAL_CLIENT_SECRET": d["secret"],
    "PAYPAL_API_BASE": d.get("api_base", "https://api-m.sandbox.paypal.com"),
    "PAYPAL_BUYER_EMAIL": buyer.get("email", ""),
    "PAYPAL_BUYER_PASSWORD": buyer.get("password", ""),
}
for k, v in pairs.items():
    print(f"export {k}={shlex.quote(v)}")
PY
)"
exec "$@"
