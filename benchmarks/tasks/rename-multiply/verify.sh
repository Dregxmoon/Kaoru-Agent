#!/usr/bin/env bash
# Verifica que la tarea rename-multiply esté bien resuelta.
# Salida: exit 0 si OK, exit 1 con mensaje si falla.
set -u

WS="${1:?uso: verify.sh <workspace>}"

grep -q "function multiply" "$WS/src/calc.js" || { echo "calc.js: falta function multiply"; exit 1; }
grep -q "multiply" "$WS/src/calc.js" || { echo "calc.js: falta multiply"; exit 1; }
grep -q "oldName" "$WS/src/calc.js" && { echo "calc.js: oldName no debe existir"; exit 1; }
grep -q "multiply" "$WS/src/calc.test.js" || { echo "calc.test.js: falta referencia a multiply"; exit 1; }

echo "OK: rename-multiply resuelta correctamente"
exit 0
