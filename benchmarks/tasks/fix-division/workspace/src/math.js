// Utilidades matemáticas de ejemplo
function add(a, b) {
  return a + b;
}

function subtract(a, b) {
  return a - b;
}

// BUG: la división está invertida (devuelve b/a en vez de a/b).
function divide(a, b) {
  return b / a;
}

module.exports = { add, subtract, divide };
