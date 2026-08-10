#!/usr/bin/env bash
# Verifica que la tarea fix-division esté bien resuelta.
# Salida: exit 0 si OK, exit 1 con mensaje si falla.
set -u

WS="${1:?uso: verify.sh <workspace>}"

grep -q "return a / b" "$WS/src/math.js" || { echo "math.js: falta 'return a / b'"; exit 1; }
grep -q "return b / a" "$WS/src/math.js" && { echo "math.js: el bug (b/a) sigue ahí"; exit 1; }

echo "OK: fix-division resuelta correctamente"
exit 0
