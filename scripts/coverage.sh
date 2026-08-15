#!/usr/bin/env bash
#
# coverage.sh — cobertura del núcleo de agente (core/planner + core/decision).
#
# Las suites corren bajo el Node de Electron (ELECTRON_RUN_AS_NODE=1) porque
# better-sqlite3 y sqlite-vec están compilados para el ABI de Electron. Se
# instrumenta con V8 coverage (NODE_V8_COVERAGE) y se genera el reporte con
# `c8 report` (el wrapper directo de c8 no reporta bien con el binario de
# Electron, así que se separan las fases).
#
# Uso:
#   bash scripts/coverage.sh          # reporte text + lcov, sin umbrales
#   bash scripts/coverage.sh --check  # además valida umbrales (falla si baja)
set -u
cd "$(dirname "$0")/.."

ELECTRON="$(node -e "console.log(require('path').join(process.cwd(),'node_modules/electron/dist/electron'))")"
if [[ ! -x "$ELECTRON" ]]; then
  echo "ERROR: no se encontró el binario de Electron en: $ELECTRON"
  echo "Ejecutá primero: npm install"
  exit 1
fi

COV_DIR=".coverage"
CHECK=0
if [[ "${1:-}" == "--check" ]]; then CHECK=1; fi
rm -rf "$COV_DIR"
mkdir -p "$COV_DIR"

# Suites que ejercitan core/planner (loop, tools, verify, subagentes, métricas,
# checkpoint) y core/decision (núcleo de decisión, gate, normalizador, SLO).
SUITES=(
  test_decision_core
  test_signal_normalizer
  test_context_gate
  test_slo
  test_proactive
  test_learning
  test_agent_loop
  test_agent_loop_lsp
  test_agent_loop_git
  test_agent_loop_mode
  test_tool_calling
  test_tool_precedence
  test_tool_visibility
  test_tools_e2e
  test_web_tools
  test_untrusted_content
  test_verify_step
  test_run_metrics
  test_browser_bridge
  test_openclaw_bridge
  test_openclaw_bridge_timing
  test_openclaw_sandbox_visibility
  test_asr_client
  test_planner
  test_main_loop_report_parse
  test_subagent_report_audit
  test_subagent_summary_parse
  test_workspace_checkpoint
  test_cli_checkpoint
)

FAILED=0
for s in "${SUITES[@]}"; do
  if ! NODE_V8_COVERAGE="$COV_DIR" ELECTRON_RUN_AS_NODE=1 "$ELECTRON" "tests/$s.js" >/dev/null 2>&1; then
    echo "FALLO en suite: $s"
    FAILED=1
  fi
done

REPORTERS=(--reporter=text --reporter=lcov)
if [[ "$CHECK" -eq 1 ]]; then
  # Umbrales = baseline medido con buffer (~5-8 pts abajo para no fallar por
  # variación: líneas/statements 80, branch 73, funcs 70). El gate es GUARD de
  # regresión, no un target: el reporte text/lcov es el artefacto accionable.
  REPORTERS+=(--check-coverage --lines 74 --functions 62 --branches 66 --statements 74)
fi

npx c8 report \
  --temp-directory="$COV_DIR" \
  "${REPORTERS[@]}" \
  --include='core/planner/**' \
  --include='core/decision/**'

exit "$FAILED"
