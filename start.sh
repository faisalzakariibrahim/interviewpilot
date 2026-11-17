#!/bin/bash
# InterviewPilot launcher.
#
# Installs what's missing, starts the backend and the web app on this machine
# only (127.0.0.1), and opens the page. Press Ctrl-C, or close this window, to
# stop both.
#
#   ./start.sh           install if needed, then run
#   ./start.sh --check   install if needed, start, confirm both answer, stop
#
# Written for the bash 3.2 that ships with macOS.

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT" || exit 1
LOGS="$ROOT/.logs"
mkdir -p "$LOGS"

CHECK_ONLY=""
[ "${1:-}" = "--check" ] && CHECK_ONLY=1
NO_OPEN="${INTERVIEWPILOT_NO_OPEN:-}"

BPID=""
FPID=""

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
fail() {
  printf '\n\033[1;31mStopped:\033[0m %s\n\n' "$*"
  exit 1
}

cleanup() {
  trap - INT TERM EXIT
  [ -n "$FPID" ] && kill "$FPID" 2>/dev/null
  [ -n "$BPID" ] && kill "$BPID" 2>/dev/null
  # The dev server runs helpers of its own: stop anything this script started.
  pkill -P $$ 2>/dev/null
  wait 2>/dev/null
}
trap cleanup INT TERM EXIT

# --- tools -------------------------------------------------------------------

step "Checking Node.js and Python"

PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
if ! command -v node >/dev/null 2>&1; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
fi
command -v node >/dev/null 2>&1 || fail "Node.js isn't installed. Install version 20.9 or newer from https://nodejs.org, then run this again."
NODE_OK="$(node -e 'var v=process.versions.node.split(".").map(Number);process.stdout.write(v[0]>20||(v[0]===20&&v[1]>=9)?"yes":"no")')"
[ "$NODE_OK" = "yes" ] || fail "Node.js $(node -v) is too old. This app needs 20.9 or newer. With nvm: nvm install --lts"
info "Node.js $(node -v)"

PY=""
for candidate in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$candidate" >/dev/null 2>&1 &&
    "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then
    PY="$candidate"
    break
  fi
done
[ -n "$PY" ] || fail "Python 3.9 or newer isn't installed. Install it from https://www.python.org/downloads, then run this again."
info "$("$PY" --version 2>&1)"

# --- backend packages ----------------------------------------------------------

VENV="$ROOT/backend/.venv"
VPY="$VENV/bin/python"

case "$ROOT" in
  "$HOME/Desktop"/* | "$HOME/Documents"/* | "$HOME/Library/Mobile Documents"/*)
    info "Note: this folder may be synced by iCloud, which can break installed packages."
    info "If installs keep failing, move the folder to ~/projects and run it from there."
    ;;
esac

venv_ok() { [ -x "$VPY" ] && "$VPY" -m pip --version >/dev/null 2>&1; }

if ! venv_ok; then
  step "Setting up the Python environment"
  if [ -x "$VPY" ]; then
    # It exists but has no pip: try to add pip, else rebuild it.
    "$VPY" -m ensurepip --upgrade >/dev/null 2>&1
  fi
  if ! venv_ok; then
    rm -rf "$VENV"
    for candidate in "$PY" python3.13 python3.12 python3.11 python3.10 python3; do
      command -v "$candidate" >/dev/null 2>&1 || continue
      "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null || continue
      "$candidate" -m venv "$VENV" >/dev/null 2>&1 && venv_ok && break
      # Some Python builds ship without ensurepip: make the environment, then fetch pip.
      rm -rf "$VENV"
      if "$candidate" -m venv --without-pip "$VENV" >/dev/null 2>&1; then
        curl -fsSL https://bootstrap.pypa.io/get-pip.py -o "$LOGS/get-pip.py" &&
          "$VPY" "$LOGS/get-pip.py" --quiet >"$LOGS/get-pip.log" 2>&1
        venv_ok && break
      fi
      rm -rf "$VENV"
    done
  fi
  venv_ok || fail "Couldn't set up Python with pip. Install Python from https://www.python.org/downloads (it includes pip), then run this again."
  rm -f "$VENV/.requirements-stamp"
  info "Python environment ready: $("$VPY" --version 2>&1)"
fi

STAMP="$(cat backend/requirements.txt backend/requirements-optional.txt | cksum)"
if [ "$(cat "$VENV/.requirements-stamp" 2>/dev/null)" != "$STAMP" ]; then
  step "Installing backend packages (a minute or two the first time)"
  "$VPY" -m pip install --quiet --disable-pip-version-check --upgrade pip >/dev/null 2>&1
  "$VPY" -m pip install --quiet --disable-pip-version-check -r backend/requirements.txt ||
    fail "Backend packages didn't install. Check your internet connection and run this again."
  if "$VPY" -m pip install --quiet --disable-pip-version-check -r backend/requirements-optional.txt >"$LOGS/faiss-install.log" 2>&1; then
    info "FAISS installed: resume search runs in FAISS."
  else
    info "No FAISS build for this Python: resume search runs in NumPy instead. Nothing else changes."
  fi
  echo "$STAMP" >"$VENV/.requirements-stamp"
fi

# --- frontend packages ---------------------------------------------------------

if [ ! -d frontend/node_modules ] || [ frontend/package.json -nt frontend/node_modules/.package-lock.json ]; then
  step "Installing web app packages (a minute or two the first time)"
  (cd frontend && npm install --no-fund --no-audit --loglevel=error) ||
    fail "Web app packages didn't install. Check your internet connection and run this again."
fi

# --- settings files -------------------------------------------------------------

[ -f backend/.env ] || cp backend/.env.example backend/.env
[ -f frontend/.env.local ] || cp frontend/.env.local.example frontend/.env.local
chmod 600 backend/.env frontend/.env.local 2>/dev/null

# True when the variable is set in the shell or has a value in the file.
has_key() {
  [ -n "$(printenv "$1")" ] && return 0
  grep -Eq "^[[:space:]]*$1=[^[:space:]#]+" "$2" 2>/dev/null
}
MISSING_ANTHROPIC=""
MISSING_NUANCE=""
has_key ANTHROPIC_API_KEY backend/.env || MISSING_ANTHROPIC=1
has_key NUANCE_API_KEY frontend/.env.local || MISSING_NUANCE=1

# --- ports ----------------------------------------------------------------------

# The first port from $1 up that nothing on this machine is using.
free_port() {
  "$VPY" - "$1" <<'PY'
import socket
import sys

start = int(sys.argv[1])
for port in range(start, start + 50):
    busy = False
    for host in ("127.0.0.1", "::1"):
        try:
            socket.create_connection((host, port), timeout=0.3).close()
            busy = True
        except OSError:
            pass
    if not busy:
        probe = socket.socket()
        try:
            probe.bind(("127.0.0.1", port))
        except OSError:
            busy = True
        finally:
            probe.close()
    if not busy:
        print(port)
        break
PY
}

BPORT="$(free_port "${INTERVIEWPILOT_BACKEND_PORT:-8000}")"
[ -n "$BPORT" ] || fail "Couldn't find a free port for the backend."
FPORT="$(free_port "${INTERVIEWPILOT_PORT:-3000}")"
[ -n "$FPORT" ] || fail "Couldn't find a free port for the web app."
URL="http://localhost:$FPORT"

# --- start ----------------------------------------------------------------------

step "Starting InterviewPilot"

(cd backend && exec "$VPY" -m uvicorn app.main:app --host 127.0.0.1 --port "$BPORT") >"$LOGS/backend.log" 2>&1 &
BPID=$!
tries=0
until curl -sf "http://127.0.0.1:$BPORT/api/health" >/dev/null 2>&1; do
  tries=$((tries + 1))
  if ! kill -0 "$BPID" 2>/dev/null || [ "$tries" -gt 80 ]; then
    tail -n 20 "$LOGS/backend.log"
    fail "The backend didn't start. The lines above are from .logs/backend.log."
  fi
  sleep 0.5
done
info "Backend running on 127.0.0.1:$BPORT"

(cd frontend && NEXT_TELEMETRY_DISABLED=1 BACKEND_URL="http://127.0.0.1:$BPORT" exec ./node_modules/.bin/next dev -H localhost -p "$FPORT") >"$LOGS/frontend.log" 2>&1 &
FPID=$!
tries=0
until curl -sf "$URL/api/nuance-token" >/dev/null 2>&1; do
  tries=$((tries + 1))
  if ! kill -0 "$FPID" 2>/dev/null || [ "$tries" -gt 240 ]; then
    tail -n 20 "$LOGS/frontend.log"
    fail "The web app didn't start. The lines above are from .logs/frontend.log."
  fi
  sleep 0.5
done
info "Web app running on $URL"

if [ -n "$CHECK_ONLY" ]; then
  curl -sf "$URL/" >/dev/null 2>&1 || fail "The page didn't load. See .logs/frontend.log."
  step "Check passed: both parts start and answer."
  exit 0
fi

step "InterviewPilot is running: $URL"
if [ -n "$MISSING_ANTHROPIC" ] || [ -n "$MISSING_NUANCE" ]; then
  echo
  info "Before your first interview, add your keys. No restart needed after saving."
  [ -n "$MISSING_ANTHROPIC" ] && info "  - Anthropic key -> backend/.env         (ANTHROPIC_API_KEY=)"
  [ -n "$MISSING_NUANCE" ] && info "  - Nuance key    -> frontend/.env.local  (NUANCE_API_KEY=)   from https://platform.nuancelabs.ai"
fi
echo
info "Keep this window open while you practise. Press Ctrl-C here to stop."

if [ "$(uname)" = "Darwin" ] && [ -z "$NO_OPEN" ]; then
  open "$URL"
  # Open the settings files that still need a key, in TextEdit.
  [ -n "$MISSING_ANTHROPIC" ] && open -e backend/.env
  [ -n "$MISSING_NUANCE" ] && open -e frontend/.env.local
fi

while kill -0 "$BPID" 2>/dev/null && kill -0 "$FPID" 2>/dev/null; do
  sleep 2
done
printf '\nOne part of the app stopped. Recent log lines:\n'
tail -n 8 "$LOGS/backend.log" "$LOGS/frontend.log"
exit 1
