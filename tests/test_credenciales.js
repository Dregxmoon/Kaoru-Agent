'use strict';

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

const { execute } = require('../core/commands/CommandRegistry.js');

// ── Contexto simulado (LLMProvider + IPC de guardado) ───────────────────────

const mockProviders = [
  { id: 'groq', name: 'Groq', hasKey: true, free: true, builtin: true },
  { id: 'gemini', name: 'Google Gemini', hasKey: false, free: true, builtin: true },
  { id: 'openai', name: 'OpenAI', hasKey: false, free: false, builtin: true },
  { id: 'anthropic', name: 'Anthropic', hasKey: true, free: false, builtin: true },
  { id: 'xai', name: 'xAI', hasKey: false, free: false, builtin: true },
];

function makeCtx() {
  let configured = null;
  const savedKeys = [];
  const ctx = {
    LLMProvider: {
      getActiveProvider: () => configured || 'groq',
      configure: (cfg) => {
        configured = cfg.llm.primary;
      },
      getAvailableProviders: () => mockProviders,
    },
    ipcRenderer: {
      invoke: async (ch, data) => {
        if (ch === 'save-llm-keys') {
          savedKeys.push(data);
          return true;
        }
        return true;
      },
    },
    sendIPC: () => {},
  };
  ctx._savedKeys = savedKeys;
  ctx._getConfigured = () => configured;
  return ctx;
}

// ── Test 1: /credenciales sin argumentos lista proveedores ──────────────────

function testCredencialesList() {
  console.log(C.bold('\n── Test 1: /credenciales sin argumentos ────────────────────'));
  const ctx = makeCtx();
  return execute('/credenciales', ctx).then((r) => {
    assert(!r.error, 'sin error');
    assert(
      r.result.includes('Usa: `/credenciales <provider> <tu-key>`'),
      'muestra hint de sintaxis'
    );
    assert(r.result.includes('**Proveedores disponibles:**'), 'lista proveedores');
    assert(r.result.includes('Groq'), 'menciona Groq');
    assert(r.result.includes('Google Gemini'), 'menciona Google Gemini');
    assert(/1\. Groq/.test(r.result), 'lista numerada');
    assert(r.result.includes(' [conectado]'), 'marca providers con key');
    assert(ctx._savedKeys.length === 0, 'no guarda nada');
  });
}

// ── Test 2: /credenciales <provider> sin key ────────────────────────────────

function testCredencialesHint() {
  console.log(C.bold('\n── Test 2: /credenciales <provider> sin key ─────────────────'));
  const ctx = makeCtx();
  return execute('/credenciales groq', ctx)
    .then((r) => {
      assert(!r.error, 'sin error');
      assert(
        r.result === 'Pegá la key: /credenciales groq <tu-key>',
        'responde hint de sintaxis exacto',
        r.result
      );
      assert(ctx._savedKeys.length === 0, 'no guarda nada');
    })
    .then(() => execute('/credenciales noexiste', ctx))
    .then((r) => {
      assert(
        /No existe el proveedor `noexiste`/.test(r.result),
        'provider inválido → error puntual'
      );
    });
}

// ── Test 3: /credenciales <provider> <key> guarda directo ───────────────────

function testCredencialesSave() {
  console.log(C.bold('\n── Test 3: /credenciales <provider> <key> ───────────────────'));
  const ctx = makeCtx();
  return (
    execute('/credenciales groq gsk_xyz123', ctx)
      .then((r) => {
        assert(!r.error, 'sin error');
        assert(/✓ API key de \*\*Groq\*\* guardada/.test(r.result), 'confirma guardado', r.result);
        assert(!r.result.includes('gsk_xyz123'), 'la respuesta NO contiene la key en claro');
        assert(ctx._savedKeys.length === 1, 'se llamó a save-llm-keys una vez');
        assert(
          ctx._savedKeys[0].providers.groq === 'gsk_xyz123',
          'guarda la key del provider correcto'
        );
        assert(ctx._savedKeys[0].useKeychain === true, 'usa keychain');
        assert(
          !('models' in ctx._savedKeys[0]) || ctx._savedKeys[0].models !== undefined,
          'incluye models'
        );
      })
      // Por número (índice 1 = Groq)
      .then(() => execute('/credenciales 1 gsk_por_indice', ctx))
      .then((r) => {
        assert(/API key de \*\*Groq\*\*/.test(r.result), 'acepta número de la lista');
        assert(ctx._savedKeys[1].providers.groq === 'gsk_por_indice', 'guarda key por índice');
      })
      // Case-insensitive
      .then(() => execute('/credenciales GROQ gsk_case', ctx))
      .then((r) => {
        assert(/API key de \*\*Groq\*\*/.test(r.result), 'acepta id en mayúsculas');
      })
      // Por nombre completo (con espacios → entre comillas)
      .then(() => execute('/credenciales "Google Gemini" AIzaSufijo', ctx))
      .then((r) => {
        assert(
          /API key de \*\*Google Gemini\*\*/.test(r.result),
          'acepta nombre completo entre comillas'
        );
        assert(ctx._savedKeys[3].providers.gemini === 'AIzaSufijo', 'guarda key de Gemini');
      })
      // Provider inválido con key
      .then(() => execute('/credenciales noexiste sk_abc', ctx))
      .then((r) => {
        assert(/No existe el proveedor/.test(r.result), 'provider inválido con key → error');
      })
  );
}

// ── Test 4: /provider <nombre> directo == set ───────────────────────────────

function testProviderDirect() {
  console.log(C.bold('\n── Test 4: /provider <nombre> directo ───────────────────────'));
  const ctx = makeCtx();
  return execute('/provider groq', ctx)
    .then((r) => {
      assert(
        /Proveedor cambiado a: \*\*Groq\*\*/.test(r.result),
        'provider con key → cambia',
        r.result
      );
      assert(ctx._getConfigured() === 'groq', 'configure llamado con groq');
    })
    .then(() => execute('/provider gemini', ctx))
    .then((r) => {
      assert(
        /Gemini no tiene API key\. Usá: \/credenciales gemini <tu-key>/.test(r.result),
        'provider sin key → no cambia y sugiere /credenciales',
        r.result
      );
      assert(ctx._getConfigured() === 'groq', 'no cambia a un provider sin key');
    })
    .then(() => execute('/provider anon', ctx))
    .then((r) => {
      assert(/Proveedores LLM disponibles/.test(r.result), 'nombre inválido → listado general');
    });
}

// ── Test 5: subcomandos de /provider intactos ───────────────────────────────

function testProviderSubcommands() {
  console.log(C.bold('\n── Test 5: /provider subcomandos intactos ───────────────────'));
  const ctx = makeCtx();
  return execute('/provider add groq', ctx)
    .then((r) => {
      assert(/Uso: `\/provider add <nombre> <url>/.test(r.result), 'add sin url → uso explícito');
    })
    .then(() => execute('/provider set gemini', ctx))
    .then((r) => {
      assert(/no tiene API key configurada/.test(r.result), 'set a provider sin key → aviso');
    })
    .then(() => execute('/provider set groq', ctx))
    .then((r) => {
      assert(/Proveedor cambiado a: \*\*Groq\*\*/.test(r.result), 'set con key → cambia');
    })
    .then(() => execute('/provider', ctx))
    .then((r) => {
      assert(/Proveedores LLM disponibles/.test(r.result), 'provider sin args → listado general');
      assert(
        /\/provider add <nombre> <url> <fastModel> \[smartModel\]/.test(r.result),
        'listado documenta add'
      );
    });
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  await testCredencialesList();
  await testCredencialesHint();
  await testCredencialesSave();
  await testProviderDirect();
  await testProviderSubcommands();

  console.log(C.bold('\n════════════════════════════════════════════════════════'));
  const total = passed + failed;
  console.log(
    C.bold(
      `  Resultado: ${C.green(passed + ' passed')}  ${failed > 0 ? C.red(failed + ' failed') : C.dim('0 failed')}  / ${total} total`
    )
  );
  console.log(C.bold('════════════════════════════════════════════════════════\n'));

  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(C.red('\nERROR FATAL:'), e.message);
  console.error(e.stack);
  process.exit(1);
});
