#!/usr/bin/env bash
#
# run-all.sh — regresión completa del asistente.
#
# Corre cada suite con el Node de Electron (ELECTRON_RUN_AS_NODE=1) porque
# better-sqlite3 y sqlite-vec están compilados para el ABI de Electron, no
# para el Node del sistema. Bajo `node` del sistema, StateGraph cae a memoria
# en RAM y las pruebas de indexado/matching semántico se saltan o fallan.
#
# Uso:
#   bash tests/run-all.sh                 # todas las suites
#   bash tests/run-all.sh tests/test_skills.js tests/test_intent_detection.js
set -u
cd "$(dirname "$0")/.."

ELECTRON="$(node -e "console.log(require('path').join(process.cwd(),'node_modules/electron/dist/electron'))")"

if [[ ! -x "$ELECTRON" ]]; then
  echo "ERROR: no se encontró el binario de Electron en: $ELECTRON"
  echo "Ejecutá primero: npm install"
  exit 1
fi

if [[ ! -f data/core.db ]]; then
  echo "⚠  No existe data/core.db — test_intent_detection necesita las intenciones indexadas."
  echo "   Ejecutá primero (también bajo Electron):"
  echo "   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron infrastructure/database/init_vectors.js"
  echo
fi

SUITES=("$@")
if [[ ${#SUITES[@]} -eq 0 ]]; then
  SUITES=(tests/test_*.js tests/e2e/test_*.js)
  # tests/benchmarks/grade_run.js queda afuera del glob por defecto: a diferencia
  # del resto, necesita corridas manuales previas en tests/benchmarks/runs/ (ver
  # tests/benchmarks/README.md). Correlo explícito:
  #   bash tests/run-all.sh tests/benchmarks/grade_run.js
fi

strip_ansi() { sed -r 's/\x1B\[[0-9;]*[mK]//g'; }

declare -a FAILED_SUITES=()
TOTAL_PASS=0
TOTAL_FAIL=0

for suite in "${SUITES[@]}"; do
  if [[ ! -f "$suite" ]]; then
    echo "── $suite (no existe, omitida)"
    continue
  fi

  echo ""
  echo "────────────────── $suite ──────────────────"
  out="$(ELECTRON_RUN_AS_NODE=1 "$ELECTRON" "$suite" 2>&1)"
  code=$?

  clean="$(printf '%s\n' "$out" | strip_ansi)"
  res="$(printf '%s\n' "$clean" | grep -E 'Resultado' | tail -1)"
  passed="$(printf '%s\n' "$res" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+' || echo 0)"
  failed="$(printf '%s\n' "$res" | grep -oE '[0-9]+ failed' | grep -oE '[0-9]+' || echo 0)"

  if [[ "$code" -eq 0 ]]; then
    echo "  ✔  $res"
    TOTAL_PASS=$((TOTAL_PASS + passed))
    TOTAL_FAIL=$((TOTAL_FAIL + failed))
  else
    echo "  ✘  $res   (exit $code)"
    printf '%s\n' "$clean" | tail -8
    if [[ "$failed" -gt 0 ]]; then TOTAL_FAIL=$((TOTAL_FAIL + failed)); else TOTAL_FAIL=$((TOTAL_FAIL + 1)); fi
    FAILED_SUITES+=("$suite")
  fi
done

echo ""
echo "══════════════════════════════════════════════════════"
echo "  RESULTADO GLOBAL:  $TOTAL_PASS passed · $TOTAL_FAIL failed"
if [[ ${#FAILED_SUITES[@]} -gt 0 ]]; then
  echo "  Fallaron: ${FAILED_SUITES[*]}"
  exit 1
fi
echo "  TODAS LAS SUITES EN VERDE"
echo "══════════════════════════════════════════════════════"
exit 0
