#!/usr/bin/env bash
# Proba completa: Worker real (wrangler dev) + D1 local con seed + Google falso + navegador.
#
#   tests/run.sh            # todas as probas
#   tests/run.sh api        # só as de API
#   tests/run.sh e2e        # só as de navegador
#
# Requisitos: node, python3, `pip install playwright && playwright install chromium`,
# e `npm install` en infra/cloudflare (ou WRANGLER="ruta/a/wrangler").
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
WRANGLER="${WRANGLER:-npx --prefix $ROOT/infra/cloudflare wrangler}"
PORT=8799
export NO_PROXY="localhost,127.0.0.1" no_proxy="localhost,127.0.0.1"
export FOLEAR_APP="http://localhost:$PORT"
SUITE="${1:-all}"

if curl -s -o /dev/null "http://localhost:$PORT/" 2>/dev/null || curl -s -o /dev/null "http://127.0.0.1:9911/x" 2>/dev/null; then
  echo "O porto $PORT (ou o 9911) xa está ocupado: pecha o Worker/Google falso anterior" >&2; exit 1
fi

PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do [ -n "$p" ] && { kill -TERM -- "-$p" 2>/dev/null || kill "$p" 2>/dev/null; }; done; }
trap cleanup EXIT

python3 tests/harness/setup_env.py "$WRANGLER" || { echo "Fallou a preparación do contorno"; exit 1; }

setsid python3 tests/harness/fakegoogle.py > tests/.tmp/fakegoogle.log 2>&1 &
PIDS+=($!)
( cd tests/.tmp && exec setsid $WRANGLER dev --local --port "$PORT" --persist-to state > wrangler.log 2>&1 ) &
PIDS+=($!)

for _ in $(seq 1 60); do
  curl -fs "$FOLEAR_APP/api/auth/me" > /dev/null 2>&1 && break
  sleep 1
done
curl -fs "$FOLEAR_APP/api/auth/me" > /dev/null || { echo "O Worker non arrincou (ver tests/.tmp/wrangler.log)"; exit 1; }

STATUS=0
run() {
  local script="$1"
  echo "=== $script"
  local out
  out="$(python3 "$script" 2>&1)"; local code=$?
  echo "$out" | grep -E "^(PASS|FAIL)|Traceback|Error" | sed 's/^/    /' | grep -v "^    PASS" || true
  if [ $code -ne 0 ] || echo "$out" | grep -q "^FAIL "; then
    echo "    -> FALLOU ($script)"; echo "$out" | tail -15 | sed 's/^/       /'; STATUS=1
  else
    echo "    -> ok ($(echo "$out" | grep -c '^PASS') comprobacións)"
  fi
}

if [ "$SUITE" = all ] || [ "$SUITE" = api ]; then for f in tests/api/test_*.py; do run "$f"; done; fi
if [ "$SUITE" = all ] || [ "$SUITE" = e2e ]; then for f in tests/e2e/test_*.py; do run "$f"; done; fi

[ $STATUS -eq 0 ] && echo "TODO OK" || echo "HAI FALLOS"
exit $STATUS
