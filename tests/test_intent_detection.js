/**
 * test_intent_detection.js — Fase 3 (Pruebas de validación)
 *
 * Valida que el sistema de detección semántica funcione correctamente
 * SIN una sola expresión regular en el pipeline principal.
 *
 * Pruebas incluidas:
 *   1. Detección básica con frase directa
 *   2. Frase narrativa/implícita ("Asistente, modifícame el script principal")
 *   3. Umbral correcto — preguntas conversacionales NO activan herramientas
 *   4. Detección multilingüe (inglés)
 *   5. Parsing del bloque estructurado
 *   6. Fallback correcto cuando el LLM no incluye bloque estructurado
 *
 * Uso:
 *   node tests/test_intent_detection.js
 *
 * Requiere que init_vectors.js ya haya corrido al menos una vez.
 */

'use strict';

const path = require('path');

// ── Colores para consola ──────────────────────────────────────────────────────
const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
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

// ── Casos de prueba ───────────────────────────────────────────────────────────

const TEST_CASES = [
  // ── Deben detectar herramienta (detected: true) ──
  {
    message: 'Asistente, modifícame el script principal',
    expectedAction: 'edit_file',
    expectedLevel: ['high', 'medium'],
    shouldDetect: true,
    label: 'Frase narrativa implícita → edit_file',
  },
  {
    message: 'crea un archivo llamado utils.js',
    expectedAction: 'create_file',
    expectedLevel: ['high', 'medium'],
    shouldDetect: true,
    label: 'Frase directa → create_file',
  },
  {
    message: 'ejecuta npm install en la terminal',
    expectedAction: 'install_package',
    expectedLevel: ['high', 'medium'],
    shouldDetect: true,
    label: 'Instalación de paquete',
  },
  {
    message: 'haz un commit con los cambios de hoy',
    expectedAction: 'git_action',
    expectedLevel: ['high', 'medium'],
    shouldDetect: true,
    label: 'Acción git',
  },
  {
    message: 'busca en internet cómo configurar webpack',
    expectedAction: 'web_search',
    expectedLevel: ['high', 'medium'],
    shouldDetect: true,
    label: 'Búsqueda web',
  },
  {
    message: 'list the files in the project folder',
    expectedAction: 'list_directory',
    expectedLevel: ['high', 'medium'],
    shouldDetect: true,
    label: 'Comando en inglés → list_directory',
  },
  {
    message: 'lee el archivo package.json',
    expectedAction: 'read_file',
    expectedLevel: ['high', 'medium'],
    shouldDetect: true,
    label: 'Leer archivo',
  },

  // ── NO deben detectar herramienta (detected: false) ──
  {
    message: 'hola Asistente, cómo estás hoy?',
    shouldDetect: false,
    label: 'Saludo → NO herramienta',
  },
  {
    message: 'qué es un closure en JavaScript?',
    shouldDetect: false,
    label: 'Pregunta técnica conceptual → NO herramienta',
  },
  {
    message: 'me puedes explicar cómo funciona React?',
    shouldDetect: false,
    label: 'Solicitud de explicación → NO herramienta',
  },
  {
    message: 'recuerdas lo que te conté ayer sobre el proyecto?',
    shouldDetect: false,
    label: 'Pregunta de memoria → NO herramienta',
  },
];

// ── Casos para StructuredActionParser ────────────────────────────────────────

const PARSER_TEST_CASES = [
  {
    label: 'Parsea bloque edit_file con ARCHIVO',
    llmResponse: `
Claro, voy a editar el archivo principal del proyecto.

\`\`\`action
ACCIÓN: edit_file | ARCHIVO: src/main.js
\`\`\`
    `,
    userGoal: 'modifícame el script principal',
    expectedTool: 'edit_file',
    expectedSource: 'structured',
    shouldParse: true,
  },
  {
    label: 'Parsea bloque run_command con COMANDO',
    llmResponse: `
Ejecutaré npm install para instalar las dependencias.

\`\`\`action
ACCIÓN: run_command | COMANDO: npm install
\`\`\`
    `,
    userGoal: 'instala las dependencias',
    expectedTool: 'exec',
    expectedSource: 'structured',
    shouldParse: true,
  },
  {
    label: 'Parsea bloque web_search con QUERY',
    llmResponse: `
Voy a buscar eso en internet.

\`\`\`action
ACCIÓN: web_search | QUERY: cómo configurar webpack 5
\`\`\`
    `,
    userGoal: 'busca cómo configurar webpack',
    expectedTool: 'web_search',
    expectedSource: 'structured',
    shouldParse: true,
  },
  {
    // Regresión: create_file estaba mapeado a tool 'write' en vez de
    // 'create_file', así que nunca disparaba el flujo especial de
    // Planner._executeCreateFile (llm → write → verify) y en su lugar
    // habría llamado a OpenClawBridge.execute('write', {path, instruction})
    // directo — con 'content' undefined, porque el schema de 'write' espera
    // {path, content}, no {path, instruction}.
    label: 'Parsea bloque create_file con ARCHIVO (tool debe ser create_file, no write)',
    llmResponse: `
Voy a crear ese archivo.

\`\`\`action
ACCIÓN: create_file | ARCHIVO: notas.txt
\`\`\`
    `,
    userGoal: 'créame un archivo de notas',
    expectedTool: 'create_file',
    expectedSource: 'structured',
    shouldParse: true,
  },
  {
    label: 'Respuesta sin bloque → array vacío (sin crash)',
    llmResponse: 'Claro, te ayudo con eso. ¿Puedes darme más detalles?',
    userGoal: 'modifica el archivo',
    shouldParse: false,
  },
  {
    label: 'Bloque malformado → ignora graciosamente',
    llmResponse: '```action\nSin campo ACCIÓN aquí\n```',
    userGoal: '',
    shouldParse: false,
  },
];

// ── Runner ────────────────────────────────────────────────────────────────────

async function runIntentDetectorTests(detector) {
  console.log(C.bold('\n── Test Suite 1: IntentDetector ──────────────────────────────'));

  for (const tc of TEST_CASES) {
    console.log(`\n${C.cyan('→')} "${tc.message}"`);
    console.log(
      `  ${C.dim('Esperado: ' + (tc.shouldDetect ? tc.expectedAction : 'NO herramienta'))}`
    );

    let result;
    try {
      result = await detector.detect(tc.message);
    } catch (e) {
      assert(false, tc.label, `Error: ${e.message}`);
      continue;
    }

    const { detected, action, confidence, level } = result;
    const scoreStr = (confidence * 100).toFixed(1) + '%';

    console.log(
      `  ${C.dim('Resultado: detected=' + detected + ' action=' + action + ' score=' + scoreStr + ' level=' + level)}`
    );

    if (tc.shouldDetect) {
      assert(
        detected && action === tc.expectedAction,
        tc.label,
        `detected=${detected} action=${action} (esperado: ${tc.expectedAction})`
      );
      assert(
        tc.expectedLevel.includes(level),
        `  nivel correcto (${tc.expectedLevel.join('|')})`,
        `nivel actual: ${level}`
      );
    } else {
      assert(!detected, tc.label, `Se detectó incorrectamente: action=${action} score=${scoreStr}`);
    }
  }
}

function runStructuredParserTests() {
  console.log(C.bold('\n── Test Suite 2: StructuredActionParser ──────────────────────'));

  const { StructuredActionParser } = require('../core/planner/StructuredActionParser.js');
  const parser = new StructuredActionParser(process.cwd());

  for (const tc of PARSER_TEST_CASES) {
    console.log(`\n${C.cyan('→')} ${tc.label}`);

    let actions;
    try {
      actions = parser.parse(tc.llmResponse, tc.userGoal, null);
    } catch (e) {
      assert(false, tc.label, `Error: ${e.message}`);
      continue;
    }

    if (tc.shouldParse) {
      assert(actions.length > 0, 'Detecta al menos una acción', `acciones: ${actions.length}`);
      if (actions.length > 0) {
        assert(
          actions[0].tool === tc.expectedTool,
          `Tool correcta: ${tc.expectedTool}`,
          `actual: ${actions[0].tool}`
        );
        assert(
          actions[0].source === tc.expectedSource,
          `Source = '${tc.expectedSource}'`,
          `actual: ${actions[0].source}`
        );
      }
    } else {
      // Sin bloque estructurado → puede devolver 0 (structured) o legacy
      // Lo importante es que no crashee
      assert(true, 'No crashea con respuesta sin bloque');
      if (actions.length === 0) {
        assert(true, 'Devuelve array vacío correctamente');
      } else {
        console.log(
          `  ${C.dim('Nota: ActionParser legacy capturó ' + actions.length + ' acciones (fallback)')}`
        );
      }
    }
  }
}

async function main() {
  console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
  console.log(C.bold(C.cyan('  March 7th — Test Suite: Detección Semántica Fase 3')));
  console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

  // ── Cargar dependencias ───────────────────────────────────────────────────
  let Database, sqliteVec;

  try {
    Database = require('better-sqlite3');
    sqliteVec = require('sqlite-vec');
  } catch (e) {
    console.error(C.red('\nERROR: Dependencias faltantes:'), e.message);
    console.error('Ejecuta: npm install better-sqlite3 sqlite-vec @xenova/transformers');
    process.exit(1);
  }

  // ── Abrir DB ──────────────────────────────────────────────────────────────
  const DB_PATH = path.join(__dirname, '../data/core.db');

  let db;
  try {
    db = new Database(DB_PATH);
    sqliteVec.load(db);
  } catch (e) {
    console.error(C.red('\nERROR: No se pudo abrir core.db:'), e.message);
    console.error('Asegúrate de haber ejecutado: node infrastructure/database/init_vectors.js');
    process.exit(1);
  }

  // ── IntentDetector ────────────────────────────────────────────────────────
  const { IntentDetector } = require('../core/grounding/IntentDetector.js');
  const detector = new IntentDetector(db);

  if (!detector._ready) {
    console.error(C.red('\nERROR: IntentDetector no está listo.'));
    console.error('Ejecuta: node infrastructure/database/init_vectors.js');
    db.close();
    process.exit(1);
  }

  console.log(C.dim('\nCalentando modelo (primera carga ~5-10s)...'));
  await detector.warmup();

  // ── Ejecutar tests ────────────────────────────────────────────────────────
  await runIntentDetectorTests(detector);
  runStructuredParserTests();

  // ── Resumen ───────────────────────────────────────────────────────────────
  console.log(C.bold('\n════════════════════════════════════════════════════════'));
  const total = passed + failed;
  console.log(
    C.bold(
      `  Resultado: ${C.green(passed + ' passed')}  ${failed > 0 ? C.red(failed + ' failed') : C.dim('0 failed')}  / ${total} total`
    )
  );
  console.log(C.bold('════════════════════════════════════════════════════════\n'));

  db.close();
  require('../core/grounding/EmbedService.js').dispose();

  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(C.red('\nERROR FATAL:'), e.message);
  console.error(e.stack);
  process.exit(1);
});
