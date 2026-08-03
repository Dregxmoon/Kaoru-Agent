#!/usr/bin/env bash
#
# run_tests.sh — regresión estructurada con salida JSON.
#
# Misma lógica que run-all.sh pero produce JSON para que el agente y el
# benchmark puedan parsear los resultados automáticamente.
#
# Uso:
#   bash tests/run_tests.sh                    # todas las suites → JSON
#   bash tests/run_tests.sh tests/test_lsp.js  # suites específicas
#   bash tests/run_tests.sh --pretty           # JSON con indentación
#
# Salida: JSON en stdout con estructura:
#   { "passed": N, "failed": N, "total": N, "exitCode": 0|1,
#     "suites": [{ "name": "...", "passed": N, "failed": N, "exitCode": 0|1 }] }
#
set -u
cd "$(dirname "$0")/.."

ELECTRON="$(node -e "console.log(require('path').join(process.cwd(),'node_modules/electron/dist/electron'))")"

if [[ ! -x "$ELECTRON" ]]; then
  echo '{"error":"Electron not found","passed":0,"failed":1,"total":0,"exitCode":1,"suites":[]}'
  exit 1
fi

PRETTY=""
SUITES=()

for arg in "$@"; do
  case "$arg" in
    --pretty) PRETTY="y" ;;
    *)        SUITES+=("$arg") ;;
  esac
done

if [[ ${#SUITES[@]} -eq 0 ]]; then
  SUITES=(tests/test_*.js tests/e2e/test_*.js)
fi

strip_ansi() { sed -r 's/\x1B\[[0-9;]*[mK]//g'; }

TOTAL_PASS=0
TOTAL_FAIL=0
SUITES_JSON=""
FIRST=true

for suite in "${SUITES[@]}"; do
  if [[ ! -f "$suite" ]]; then
    continue
  fi

  out="$(ELECTRON_RUN_AS_NODE=1 "$ELECTRON" "$suite" 2>&1)"
  code=$?

  clean="$(printf '%s\n' "$out" | strip_ansi)"
  res="$(printf '%s\n' "$clean" | grep -E 'Resultado' | tail -1)"
  passed="$(printf '%s\n' "$res" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+' || echo 0)"
  failed="$(printf '%s\n' "$res" | grep -oE '[0-9]+ failed' | grep -oE '[0-9]+' || echo 0)"
  total=$((passed + failed))

  if [[ "$code" -eq 0 ]]; then
    TOTAL_PASS=$((TOTAL_PASS + passed))
    TOTAL_FAIL=$((TOTAL_FAIL + failed))
  else
    TOTAL_FAIL=$((TOTAL_FAIL + failed))
    if [[ "$failed" -eq 0 ]]; then TOTAL_FAIL=$((TOTAL_FAIL + 1)); fi
  fi

  suite_entry="{\"name\":\"$(basename "$suite")\",\"passed\":$passed,\"failed\":$failed,\"total\":$total,\"exitCode\":$code}"
  if [[ "$FIRST" == "true" ]]; then
    SUITES_JSON="$suite_entry"
    FIRST=false
  else
    SUITES_JSON="$SUITES_JSON,$suite_entry"
  fi
done

TOTAL=$((TOTAL_PASS + TOTAL_FAIL))
if [[ "$TOTAL_FAIL" -gt 0 ]]; then
  EXIT_CODE=1
else
  EXIT_CODE=0
fi

JSON="{\"passed\":$TOTAL_PASS,\"failed\":$TOTAL_FAIL,\"total\":$TOTAL,\"exitCode\":$EXIT_CODE,\"suites\":[$SUITES_JSON]}"

if [[ -n "$PRETTY" ]]; then
  echo "$JSON" | python3 -m json.tool 2>/dev/null || echo "$JSON"
else
  echo "$JSON"
fi

exit $EXIT_CODE
