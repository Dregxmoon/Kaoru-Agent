'use strict';

const { truncateSystemPrompt } = require('../core/core/context.js');

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  ${C.green('✓')} ${label}`);
    passed++;
  } else {
    console.log(`  ${C.red('✗')} ${label}`);
    if (detail) console.log(`    ${C.dim(detail)}`);
    failed++;
  }
}

const LOOP = '# MODO AGENTE — BUCLE DE EJECUCIÓN\ninstrucciones del loop';
const CATALOG = '# HERRAMIENTAS DISPONIBLES\n  - tool1: desc';
const RECALL = '# CONTEXTO RELEVANTE DE MEMORIA (sesiones previas)\nrecuerdo viejo';
const SKILLS =
  '---\n\n**Skills activas para esta tarea:**\n## Skill: my-skill\naplica tal cosa\n---';

const TAIL = [
  { name: 'Skills', marker: '---\n\n**Skills activas' },
  { name: 'Memoria recall', marker: '# CONTEXTO RELEVANTE DE MEMORIA' },
  { name: 'Catálogo de tools', marker: '# HERRAMIENTAS DISPONIBLES' },
  { name: 'Loop agente', marker: '# MODO AGENTE' },
];

function buildAgentPrompt() {
  const base = [
    'IDENTIDAD\n\n---\n\n## Contexto actual\nOS Linux\n\n---\n\n## Lo que sé del usuario\nle gusta x\n\n---\n\n# COMPORTAMIENTO ESTE TURNO\nser amable\n\n---\n\n## INTENCIÓN DE HERRAMIENTA\nread\n',
  ].join('');
  return base + '\n\n' + LOOP + '\n\n' + CATALOG + '\n\n' + RECALL + '\n\n' + SKILLS;
}

// Caso 1: prompt pequeño → sin cambios.
{
  const p = 'HOLA';
  assert(truncateSystemPrompt(p) === p, 'prompt bajo presupuesto se deja igual');
}

// Barrido de presupuestos (modo agent): para cada sección, calcula el mayor
// presupuesto con el que desaparece. Deben desaparecer en orden de menor a
// mayor importancia: skills → recall → catálogo → loop. La identidad nunca
// desaparece y el límite siempre se respeta.
const p = buildAgentPrompt();
const SECTIONS = [
  { name: 'skills', marker: '**Skills activas' },
  { name: 'recall', marker: '# CONTEXTO RELEVANTE DE MEMORIA' },
  { name: 'catálogo', marker: '# HERRAMIENTAS DISPONIBLES' },
  { name: 'loop', marker: '# MODO AGENTE' },
];

function lastBudgetWhereAbsent(marker, lo, hi) {
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const out = truncateSystemPrompt(p, { max: mid, tailSections: TAIL });
    if (!out.includes(marker)) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

const thresholds = {};
let prev = p.length;
for (const s of SECTIONS) {
  const t = lastBudgetWhereAbsent(s.marker, 1, p.length);
  thresholds[s.name] = t;
  assert(t >= 0, `"${s.name}" desaparece bajo algún presupuesto`);
  assert(t <= prev, `"${s.name}" (t=${t}) desaparece antes/igual que la anterior (t=${prev})`);
  prev = t;
}
// Con el presupuesto máximo, nada desaparece (el prompt cabe sin recortar).
{
  const out = truncateSystemPrompt(p, { max: p.length, tailSections: TAIL });
  assert(out === p, 'presupuesto = longitud exacta: sin cambios');
}
// En todos los barridos: identidad intacta y límite respetado. (Presupuestos
// ≥ 60: por debajo del sufijo de truncado —38 chars— el fallback duro ya no
// puede caber identidad + marcador; caso degenerado irrelevante en prod.)
for (const budget of [p.length - 1, 200, 100, 60, 50]) {
  const out = truncateSystemPrompt(p, { max: budget, tailSections: TAIL });
  assert(out.length <= budget, `límite respetado con budget=${budget}`);
  assert(out.startsWith('IDENTIDAD'), `identidad al inicio con budget=${budget}`);
}

// Caso 6: sin tailSections (chat/plan/execute) → solo se eliminan secciones
// `---`-delimitadas y nunca se corta identidad.
{
  const base = [
    'IDENTIDAD\n\n---\n\n## Contexto actual\nOS Linux\n\n---\n\n## Lo que sé del usuario\nmemoria\n',
  ].join('');
  const p6 = base + '\n\n' + CATALOG;
  const out = truncateSystemPrompt(p6, { max: p6.length - 5 });
  assert(out.includes('IDENTIDAD'), 'identidad conservada (6)');
  assert(!out.includes('# HERRAMIENTAS DISPONIBLES'), 'catálogo base eliminado (6)');
  assert(out.length <= p6.length - 5, 'bajo el presupuesto (6)');
}

// Caso 7 (F3.3): "Impresiones" es la sección `---`-delimitada MENOS crítica: se
// recorta antes que OS o Memoria y, en concreto, antes que la identidad.
{
  const p7 = [
    'IDENTIDAD\n\n---\n\n## Impresiones (no confirmadas: Kaoru)\ncreo que le gusta el jazz\n\n---\n\n## Contexto actual\nOS Linux\n\n---\n\n## Lo que sé del usuario\nmemoria real\n',
  ].join('');
  const mid = p7.length - 1;
  const out = truncateSystemPrompt(p7, { max: mid });
  assert(
    !out.includes('Impresiones (no confirmadas'),
    'Impresiones eliminada antes que OS/Memoria (7)'
  );
  assert(out.includes('## Contexto actual'), 'OS conservado cuando sobra presupuesto (7)');
  assert(
    out.includes('## Lo que sé del usuario'),
    'Memoria conservada cuando sobra presupuesto (7)'
  );
  assert(out.startsWith('IDENTIDAD'), 'identidad nunca se toca (7)');
  assert(out.length <= mid, 'límite respetado (7)');
}

console.log(
  `\n${C.bold('test_truncate_prompt')}: ${C.green(passed + ' pasaron')}${failed ? ', ' + C.red(failed + ' fallaron') : ''}`
);
process.exit(failed > 0 ? 1 : 0);
