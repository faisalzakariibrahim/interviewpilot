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
#        - FIRECRAWL_API_KEY  from backend/.env, if present (job-posting links)
#   4. Paid mode, only if backend/.env has STRIPE_SECRET_KEY: anyone can sign
#      up and buy interviews. It also needs SUPABASE_SERVICE_ROLE_KEY in
#      backend/.env, and registers a Stripe webhook whose signing secret is
#      kept in .stripe-webhook-secret (readable by you only).
#      Without STRIPE_SECRET_KEY it stays private: only the email you enter.
#   5. Deploys both and prints the address.
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
WEBHOOK_FILE="$ROOT/.stripe-webhook-secret"

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

FIRECRAWL_API_KEY="$(read_env FIRECRAWL_API_KEY backend/.env)"
STRIPE_SECRET_KEY="$(read_env STRIPE_SECRET_KEY backend/.env)"
SUPABASE_SERVICE_ROLE_KEY="$(read_env SUPABASE_SERVICE_ROLE_KEY backend/.env)"
if [ -n "$FIRECRAWL_API_KEY" ]; then info "Firecrawl key found (not shown)"; else info "No FIRECRAWL_API_KEY: job links use the built-in reader"; fi

PAID=""
SUPPORT_EMAIL="${SUPPORT_EMAIL:-}"
if [ -n "$STRIPE_SECRET_KEY" ]; then
  PAID=1
  case "$STRIPE_SECRET_KEY" in
    sk_test_* | rk_test_*) info "Paid mode, Stripe TEST keys: no real money moves" ;;
    sk_live_* | rk_live_*) info "Paid mode, Stripe LIVE keys: real payments" ;;
    *) fail "STRIPE_SECRET_KEY in backend/.env doesn't look like a Stripe secret key (sk_test_... or sk_live_...)." ;;
  esac
  [ -n "$SUPABASE_SERVICE_ROLE_KEY" ] ||
    fail "Paid mode also needs SUPABASE_SERVICE_ROLE_KEY in backend/.env (Supabase dashboard > Project Settings > API keys)."
  ALLOWED_EMAILS="*"
  if [ -z "$SUPPORT_EMAIL" ]; then
    printf '\n  Support email shown on the Terms and Privacy pages (public; Enter to skip): '
    read -r SUPPORT_EMAIL
  fi
else
  info "No STRIPE_SECRET_KEY: private mode (only your email can sign in)"
  ALLOWED_EMAILS="${ALLOWED_EMAILS:-}"
  if [ -z "$ALLOWED_EMAILS" ]; then
    printf '\n  Email allowed to sign in (yours): '
    read -r ALLOWED_EMAILS
  fi
  ALLOWED_EMAILS="$(printf '%s' "$ALLOWED_EMAILS" | tr 'A-Z' 'a-z' | tr -d ' ')"
  case "$ALLOWED_EMAILS" in *@*.*) ;; *) fail "That doesn't look like an email address." ;; esac
fi

# Calls Stripe with the secret key passed through stdin (curl -K -), never on the command line.
stripe_post() { # path, then form fields as key=value
  local path="$1"
  shift
  local args=()
  for field in "$@"; do args+=(--data-urlencode "$field"); done
  printf 'header = "Authorization: Bearer %s"\n' "$STRIPE_SECRET_KEY" |
    curl -s -K - -X POST "https://api.stripe.com/v1/$path" "${args[@]}"
}

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
if [ -n "$FIRECRAWL_API_KEY" ]; then set_env backend FIRECRAWL_API_KEY "$FIRECRAWL_API_KEY" sensitive; fi
if [ -n "$PAID" ]; then
  set_env backend INTERVIEWPILOT_BILLING on config
  set_env backend STRIPE_SECRET_KEY "$STRIPE_SECRET_KEY" sensitive
  set_env backend SUPABASE_SERVICE_ROLE_KEY "$SUPABASE_SERVICE_ROLE_KEY" sensitive
else
  set_env backend INTERVIEWPILOT_BILLING off config
fi

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
if [ -n "$SUPPORT_EMAIL" ]; then set_env frontend NEXT_PUBLIC_SUPPORT_EMAIL "$SUPPORT_EMAIL" config; fi

info "Deploying (two or three minutes)..."
WEB_OUT="$(cd frontend && vc deploy --prod --yes --json 2>"$ROOT/.logs-deploy-web.txt")" ||
  { tail -n 20 "$ROOT/.logs-deploy-web.txt"; fail "Web app deployment failed. The lines above say why."; }
WEB_HOST="$(printf '%s' "$WEB_OUT" | production_host)"
[ -n "$WEB_HOST" ] || fail "Couldn't find the web app's address in Vercel's answer."

# --- payments ---------------------------------------------------------------------------------

if [ -n "$PAID" ]; then
  step "Payments: Stripe webhook"
  if [ -s "$WEBHOOK_FILE" ]; then
    info "Reusing the webhook secret in .stripe-webhook-secret"
  else
    ANSWER="$(stripe_post webhook_endpoints "url=https://$API_HOST/api/stripe/webhook" \
      "enabled_events[]=checkout.session.completed" "enabled_events[]=checkout.session.async_payment_succeeded" \
      "enabled_events[]=customer.subscription.created" "enabled_events[]=customer.subscription.updated" \
      "enabled_events[]=customer.subscription.deleted" "description=InterviewPilot payments")"
    SECRET="$(printf '%s' "$ANSWER" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("secret",""))' 2>/dev/null)"
    if [ -z "$SECRET" ]; then
      REASON="$(printf '%s' "$ANSWER" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("error",{}).get("message","no answer"))' 2>/dev/null)"
      fail "Stripe didn't create the webhook: $REASON"
    fi
    (umask 077 && printf '%s' "$SECRET" >"$WEBHOOK_FILE")
    unset SECRET ANSWER
    info "Webhook created; its secret is saved in .stripe-webhook-secret (only you can read it)"
  fi
  chmod 600 "$WEBHOOK_FILE"
  set_env backend STRIPE_WEBHOOK_SECRET "$(cat "$WEBHOOK_FILE")" sensitive
  set_env backend APP_URL "https://$WEB_HOST" config
  info "Redeploying the backend with payment settings..."
  (cd backend && vc deploy --prod --yes --json >/dev/null 2>"$ROOT/.logs-deploy-api.txt") ||
    { tail -n 20 "$ROOT/.logs-deploy-api.txt"; fail "Backend redeploy failed. The lines above say why."; }
  case "$(curl -s "https://$API_HOST/api/health" || true)" in
    *'"billing":true'*) info "Payments are on" ;;
    *) info "The backend doesn't report payments on yet. Check its environment variables in Vercel." ;;
  esac
fi

unset ANTHROPIC_API_KEY NUANCE_API_KEY DATA_ENCRYPTION_KEY STRIPE_SECRET_KEY SUPABASE_SERVICE_ROLE_KEY FIRECRAWL_API_KEY

step "Done: https://$WEB_HOST"
cat <<EOF

  One last setting, in Supabase (sign-in links must come back to this address):
    1. Open https://supabase.com/dashboard/project/dopfmtriwbxfoocwlpyc/auth/url-configuration
    2. Site URL: https://$WEB_HOST
    3. Redirect URLs: add https://$WEB_HOST
    4. Save.

  Then open https://$WEB_HOST, enter your email and click the link it sends.

EOF
if [ -n "$PAID" ]; then
  cat <<EOF
  Before strangers sign up, Supabase must send sign-in emails through your own
  mail service (its built-in sender only emails your own team):
    https://supabase.com/dashboard/project/dopfmtriwbxfoocwlpyc/auth/smtp
  Resend or Postmark both work; send from a domain you own.

EOF
fi
[ "$(uname)" = "Darwin" ] && open "https://supabase.com/dashboard/project/dopfmtriwbxfoocwlpyc/auth/url-configuration"
exit 0
