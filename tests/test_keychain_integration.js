'use strict';

/**
 * Test — Fase 1 (Seguridad): integración de credenciales con el llavero.
 *
 * Verifica que LLMProvider resuelva las API keys con esta prioridad:
 * llavero del sistema > env > config.json, y que las helpers de migración
 * no escriban nada cuando el llavero no está disponible. Todo corre contra
 * un llavero simulado (nunca toca el keychain real de la máquina).
 */

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
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

function makeFakeKeychain(initial = {}) {
  const store = { ...initial };
  return {
    isAvailable: () => true,
    getKey: (id) => store[id] ?? null,
    setKey: (id, v) => {
      store[id] = v;
      return true;
    },
    deleteKey: (id) => {
      delete store[id];
      return true;
    },
    _store: store,
  };
}

function main() {
  console.log(C.bold('\n── Test: credenciales en el llavero (LLMProvider) ──────────'));

  const LLM = require('../core/llm/LLMProvider.js');

  // ── 1. Sin llavero, la key de config se usa normal ─────────────────────
  {
    LLM._setKeychainResolver(false); // fuerza "sin llavero" (no toca el real)
    LLM.configure({ llm: { apiKeys: { groq: 'CONFIG-ONLY' } } });
    const p = LLM.getAvailableProviders().find((x) => x.id === 'groq');
    assert(p && p.hasKey === true, 'sin llavero, config.json sigue funcionando');
    // Fase 1: el surface público NO expone la key; se verifica por acceso
    // explícito main-process (getResolvedApiKey).
    assert(p && !('apiKey' in p), 'getAvailableProviders no expone apiKey (Fase 1)');
    assert(
      LLM.getResolvedApiKey('groq') === 'CONFIG-ONLY',
      'sin llavero, la key resuelta es la de config'
    );
  }

  // ── 2. El llavero gana sobre config.json ───────────────────────────────
  {
    const fake = makeFakeKeychain({ groq: 'KEYCHAIN-KEY' });
    LLM._setKeychainResolver(fake);
    LLM.configure({ llm: { apiKeys: { groq: 'CONFIG-KEY' } } });
    assert(
      LLM.getResolvedApiKey('groq') === 'KEYCHAIN-KEY',
      'key del llavero tiene prioridad sobre config.json',
      LLM.getResolvedApiKey('groq')
    );
  }

  // ── 3. Llavero sin la key → cae a config ───────────────────────────────
  {
    const fake = makeFakeKeychain({});
    LLM._setKeychainResolver(fake);
    LLM.configure({ llm: { apiKeys: { groq: 'CONFIG-KEY' } } });
    assert(
      LLM.getResolvedApiKey('groq') === 'CONFIG-KEY',
      'llavero vacío no borra la key de config'
    );
  }

  // ── 4. Una key del llavero para un provider sin config también entra ───
  {
    const fake = makeFakeKeychain({ openai: 'KC-OPENAI' });
    LLM._setKeychainResolver(fake);
    LLM.configure({ llm: {} });
    assert(
      LLM.getResolvedApiKey('openai') === 'KC-OPENAI',
      'provider sin entrada en config se resuelve solo desde el llavero'
    );
  }

  // ── 5. storeProviderApiKey / removeProviderApiKey contra el fake ───────
  {
    const fake = makeFakeKeychain({});
    LLM._setKeychainResolver(fake);
    assert(
      LLM.storeProviderApiKey('gemini', 'G-KEY') === true,
      'storeProviderApiKey escribe en el llavero'
    );
    assert(fake._store.gemini === 'G-KEY', 'la key queda guardada');
    assert(LLM.removeProviderApiKey('gemini') === true, 'removeProviderApiKey borra del llavero');
    assert(fake._store.gemini === undefined, 'la key ya no está');
  }

  // ── 6. migrateApiKeysToKeychain: mueve solo las ausentes y no pisa ─────
  {
    const fake = makeFakeKeychain({ groq: 'EXISTENTE' });
    LLM._setKeychainResolver(fake);
    const r = LLM.migrateApiKeysToKeychain({
      llm: {
        apiKeys: { groq: 'NUEVA', gemini: 'NUEVA2' },
        providers: { openai: { apiKey: 'NUEVA3' } },
      },
    });
    assert(
      Array.isArray(r.migrated) && r.migrated.includes('gemini') && r.migrated.includes('openai'),
      'migra las keys ausentes (gemini, openai)',
      JSON.stringify(r.migrated)
    );
    assert(!r.migrated.includes('groq'), 'no pisa la key que ya existe en el llavero');
    assert(
      fake._store.gemini === 'NUEVA2' && fake._store.openai === 'NUEVA3',
      'las keys migradas quedan guardadas'
    );
    assert(fake._store.groq === 'EXISTENTE', 'la key existente no cambia');
  }

  // ── 7. Sin llavero, migrate/store/remove no hacen nada y no rompen ─────
  {
    LLM._setKeychainResolver(false);
    const r = LLM.migrateApiKeysToKeychain({ llm: { apiKeys: { groq: 'X' } } });
    assert(
      r.migrated.length === 0 && r.keychainAvailable === false,
      'sin llavero no migra nada (keychainAvailable=false)'
    );
    assert(LLM.storeProviderApiKey('groq', 'X') === false, 'store sin llavero devuelve false');
    assert(LLM.removeProviderApiKey('groq') === false, 'remove sin llavero devuelve false');
    // y config sigue funcionando
    LLM.configure({ llm: { apiKeys: { groq: 'SIGUE' } } });
    assert(LLM.getResolvedApiKey('groq') === 'SIGUE', 'config funciona aunque no haya llavero');
  }

  // ── 8. Keys vacías no se migran ni pisan nada ──────────────────────────
  {
    const fake = makeFakeKeychain({});
    LLM._setKeychainResolver(fake);
    const r = LLM.migrateApiKeysToKeychain({ llm: { apiKeys: { groq: '', gemini: '   ' } } });
    assert(r.migrated.length === 0, 'keys vacías/espacio no se migran', JSON.stringify(r.migrated));
    assert(Object.keys(fake._store).length === 0, 'el llavero simulado queda intacto');
  }

  LLM._setKeychainResolver(null);

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

main();
