#!/bin/bash
# Deploys InterviewPilot's cloud version to your Vercel account.
#
#   ./deploy-cloud.sh
#
# What it does, all from this Mac:
#   1. Signs you in to Vercel (once; a browser window opens).
#   2. Creates two Vercel projects: interviewpilot-api (backend) and
#      interviewpilot (web app).
#   3. Puts their settings in place. Secrets go straight from this Mac into
#      Vercel as write-only "sensitive" variables and are never printed:
#        - ANTHROPIC_API_KEY  from backend/.env
#        - NUANCE_API_KEY     from frontend/.env.local
#        - DATA_ENCRYPTION_KEY, generated here on first run and kept in
#          .cloud-encryption-key (readable by you only) so a re-run reuses it.
#   4. Deploys both and prints the address.
#
# Safe to run again: it updates settings and redeploys.
# Written for the bash 3.2 that ships with macOS.

set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT" || exit 1

SCOPE="${VERCEL_SCOPE:-faisalzakariibrahims-projects}"
API_PROJECT="${API_PROJECT:-interviewpilot-api}"
WEB_PROJECT="${WEB_PROJECT:-interviewpilot}"
# Public by design: row-level security and the allowlist protect the data.
SUPABASE_URL="https://dopfmtriwbxfoocwlpyc.supabase.co"
SUPABASE_ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRvcGZtdHJpd2J4Zm9vY3dscHljIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ5NDQ1MDMsImV4cCI6MjExMDUyMDUwM30.9RF8pNOnqDTP54YoWvXL_veim5dyoZutQrQvwR3J1xY"
KEY_FILE="$ROOT/.cloud-encryption-key"

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
fail() {
  printf '\n\033[1;31mStopped:\033[0m %s\n\n' "$*"
  exit 1
}

PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
if ! command -v node >/dev/null 2>&1; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
fi
command -v npx >/dev/null 2>&1 || fail "Node.js isn't installed. Install it from https://nodejs.org and run this again."

vc() { npx --yes vercel@65 --scope "$SCOPE" "$@"; }

# Reads KEY=value from a dotenv file without printing it.
read_env() {
  sed -n "s/^[[:space:]]*$1=//p" "$2" 2>/dev/null | tail -n 1 |
    sed 's/^[[:space:]]*//; s/[[:space:]]*$//; s/^["'\'']//; s/["'\'']$//; s/^[[:space:]]*//; s/[[:space:]]*$//' | tr -d '\r'
}

# Sets one variable on a project. Values go through stdin, never the command line.
set_env() { # project dir, name, value, sensitive|config
  local flag="--no-sensitive"
  [ "$4" = "sensitive" ] && flag="--sensitive"
  if ! printf '%s' "$3" | (cd "$1" && vc env add "$2" --environment production --force --yes $flag >/dev/null 2>&1); then
    fail "Couldn't set $2 on Vercel. Run this again; if it keeps failing, check the Vercel dashboard."
  fi
  info "$2 set"
}

# The production address of a deployment, from `vercel deploy --json` output.
production_host() {
  /usr/bin/python3 -c '
import json, re, sys
text = sys.stdin.read()
hosts = set(re.findall(r"([a-z0-9][a-z0-9-]*\.vercel\.app)", text))
try:
    data = json.loads(text[text.index("{"):])
    for key in ("alias", "aliases"):
        for item in data.get(key) or []:
            hosts.add(str(item).replace("https://", "").strip("/"))
except Exception:
    pass
print(min(hosts, key=len) if hosts else "")
'
}

# --- checks -----------------------------------------------------------------------

step "Checking your local settings"
ANTHROPIC_API_KEY="$(read_env ANTHROPIC_API_KEY backend/.env)"
NUANCE_API_KEY="$(read_env NUANCE_API_KEY frontend/.env.local)"
[ -n "$ANTHROPIC_API_KEY" ] || fail "backend/.env has no ANTHROPIC_API_KEY. Add it and run this again."
[ -n "$NUANCE_API_KEY" ] || fail "frontend/.env.local has no NUANCE_API_KEY. Add it and run this again."
info "Anthropic and Nuance keys found (not shown)"

if [ -s "$KEY_FILE" ]; then
  DATA_ENCRYPTION_KEY="$(cat "$KEY_FILE")"
  info "Reusing your encryption key from .cloud-encryption-key"
else
  command -v openssl >/dev/null 2>&1 || fail "openssl is missing."
  (umask 077 && openssl rand -base64 32 | tr -d '\n' >"$KEY_FILE")
  DATA_ENCRYPTION_KEY="$(cat "$KEY_FILE")"
  info "Generated a new encryption key, saved to .cloud-encryption-key (only you can read it)"
fi
chmod 600 "$KEY_FILE"

ALLOWED_EMAILS="${ALLOWED_EMAILS:-}"
if [ -z "$ALLOWED_EMAILS" ]; then
  printf '\n  Email allowed to sign in (yours): '
  read -r ALLOWED_EMAILS
fi
ALLOWED_EMAILS="$(printf '%s' "$ALLOWED_EMAILS" | tr 'A-Z' 'a-z' | tr -d ' ')"
case "$ALLOWED_EMAILS" in *@*.*) ;; *) fail "That doesn't look like an email address." ;; esac

# --- Vercel sign-in ------------------------------------------------------------------

step "Signing in to Vercel"
if ! npx --yes vercel@65 whoami >/dev/null 2>&1; then
  info "A browser window opens: approve the sign-in, then come back here."
  npx --yes vercel@65 login || fail "Vercel sign-in didn't finish."
fi
info "Signed in as $(npx --yes vercel@65 whoami 2>/dev/null)"

# --- backend ----------------------------------------------------------------------------

step "Backend: $API_PROJECT"
(cd backend && vc link --yes --project "$API_PROJECT" >/dev/null 2>&1) ||
  (cd backend && vc project add "$API_PROJECT" >/dev/null 2>&1; vc link --yes --project "$API_PROJECT" >/dev/null 2>&1) ||
  fail "Couldn't create or link the $API_PROJECT project."
set_env backend INTERVIEWPILOT_MODE cloud config
set_env backend SUPABASE_URL "$SUPABASE_URL" config
set_env backend SUPABASE_ANON_KEY "$SUPABASE_ANON_KEY" config
set_env backend ALLOWED_EMAILS "$ALLOWED_EMAILS" sensitive
set_env backend ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY" sensitive
set_env backend DATA_ENCRYPTION_KEY "$DATA_ENCRYPTION_KEY" sensitive

info "Deploying (a minute or two)..."
API_OUT="$(cd backend && vc deploy --prod --yes --json 2>"$ROOT/.logs-deploy-api.txt")" ||
  { tail -n 20 "$ROOT/.logs-deploy-api.txt"; fail "Backend deployment failed. The lines above say why."; }
API_HOST="$(printf '%s' "$API_OUT" | production_host)"
[ -n "$API_HOST" ] || fail "Couldn't find the backend's address in Vercel's answer."
info "Backend live at https://$API_HOST"

HEALTH="$(curl -s "https://$API_HOST/api/health" || true)"
case "$HEALTH" in
  *'"mode":"cloud"'*'"claude_configured":true'*) info "Backend check passed" ;;
  *) info "Backend answered: $HEALTH" ;;
esac

# --- web app ---------------------------------------------------------------------------------

step "Web app: $WEB_PROJECT"
(cd frontend && vc link --yes --project "$WEB_PROJECT" >/dev/null 2>&1) ||
  (cd frontend && vc project add "$WEB_PROJECT" >/dev/null 2>&1; vc link --yes --project "$WEB_PROJECT" >/dev/null 2>&1) ||
  fail "Couldn't create or link the $WEB_PROJECT project."
set_env frontend NEXT_PUBLIC_SUPABASE_URL "$SUPABASE_URL" config
set_env frontend NEXT_PUBLIC_SUPABASE_ANON_KEY "$SUPABASE_ANON_KEY" config
set_env frontend BACKEND_URL "https://$API_HOST" config
set_env frontend NEXT_TELEMETRY_DISABLED 1 config
set_env frontend NUANCE_API_KEY "$NUANCE_API_KEY" sensitive

info "Deploying (two or three minutes)..."
WEB_OUT="$(cd frontend && vc deploy --prod --yes --json 2>"$ROOT/.logs-deploy-web.txt")" ||
  { tail -n 20 "$ROOT/.logs-deploy-web.txt"; fail "Web app deployment failed. The lines above say why."; }
WEB_HOST="$(printf '%s' "$WEB_OUT" | production_host)"
[ -n "$WEB_HOST" ] || fail "Couldn't find the web app's address in Vercel's answer."

unset ANTHROPIC_API_KEY NUANCE_API_KEY DATA_ENCRYPTION_KEY

step "Done: https://$WEB_HOST"
cat <<EOF

  One last setting, in Supabase (sign-in links must come back to this address):
    1. Open https://supabase.com/dashboard/project/dopfmtriwbxfoocwlpyc/auth/url-configuration
    2. Site URL: https://$WEB_HOST
    3. Redirect URLs: add https://$WEB_HOST
    4. Save.

  Then open https://$WEB_HOST, enter your email and click the link it sends.

EOF
[ "$(uname)" = "Darwin" ] && open "https://supabase.com/dashboard/project/dopfmtriwbxfoocwlpyc/auth/url-configuration"
exit 0
