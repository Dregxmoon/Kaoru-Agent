'use strict';

// SafeStorageCrypto: cifrado de API keys vía electron.safeStorage.
// Test que verifica:1. Keys cifradas aparecen con prefijo enc:v1: en config2. Keys sin prefijo (legacy) se leen bien (compatibilidad hacia atrás)
// 3. Encrypt/decrypt round-trip
// 4. safeStorage no disponible → fallback a texto plano

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
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

const SafeStorageCrypto = require('../infrastructure/config/SafeStorageCrypto.js');

// ── Mock de electron.safeStorage ─────────────────────────────────────────────
// Simula cifrado XOR simple (NO es seguro real, solo para tests).

function makeMockSafeStorage() {
  const KEY = Buffer.from('test-encryption-key!!');
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext) => {
      const input = Buffer.from(plaintext, 'utf8');
      const out = Buffer.alloc(input.length);
      for (let i = 0; i < input.length; i++) {
        out[i] = input[i] ^ KEY[i % KEY.length];
      }
      return out;
    },
    decryptString: (buf) => {
      const out = Buffer.alloc(buf.length);
      for (let i = 0; i < buf.length; i++) {
        out[i] = buf[i] ^ KEY[i % KEY.length];
      }
      return out.toString('utf8');
    },
  };
}

function makeUnavailableSafeStorage() {
  return {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error('not available');
    },
    decryptString: () => {
      throw new Error('not available');
    },
  };
}

async function main() {
  console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
  console.log(C.bold('  SafeStorageCrypto — cifrado de API keys'));
  console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

  // ── Test 1: safeStorage disponible → encrypt/decrypt round-trip ──────────
  console.log(C.cyan('\n── Test 1: round-trip encrypt/decrypt ──────────────────'));
  SafeStorageCrypto._setSafeStorage(makeMockSafeStorage());
  assert(SafeStorageCrypto.isAvailable(), 'safeStorage disponible con mock');

  const key = 'gsk_abc123def456';
  const encrypted = SafeStorageCrypto.encrypt(key);
  assert(
    encrypted.startsWith('enc:v1:'),
    'encrypt produce prefijo enc:v1:',
    `got: ${encrypted.slice(0, 30)}...`
  );
  assert(encrypted !== key, 'encrypt no devuelve el texto original');

  const decrypted = SafeStorageCrypto.decrypt(encrypted);
  assert(decrypted === key, 'decrypt devuelve el texto original', `got: ${decrypted}`);

  // ── Test 2: key legacy sin prefijo se lee tal cual ──────────────────────
  console.log(C.cyan('\n── Test 2: compatibilidad hacia atrás (key legacy) ─────'));
  const legacyKey = 'sk-legacy-key-12345';
  const resultLegacy = SafeStorageCrypto.decrypt(legacyKey);
  assert(resultLegacy === legacyKey, 'key sin prefijo se devuelve tal cual');

  // ── Test 3: encryptAllKeys / decryptAllKeys ──────────────────────────────
  console.log(C.cyan('\n── Test 3: encryptAllKeys / decryptAllKeys ────────────'));
  // Simula el flujo real: plaintext keys → encryptAllKeys → save to config
  // → load from config → decryptAllKeys → plaintext keys
  const inputKeys = {
    groq: 'gsk_key1',
    gemini: 'AIzaSyAnotherKey',
    openai: 'sk-key3',
  };
  const encryptedAll = SafeStorageCrypto.encryptAllKeys(inputKeys);
  assert(encryptedAll.groq.startsWith('enc:v1:'), 'groq se cifra');
  assert(encryptedAll.gemini.startsWith('enc:v1:'), 'gemini se cifra');
  assert(encryptedAll.openai.startsWith('enc:v1:'), 'openai se cifra');

  // Simula leer de config.json y descifrar
  const decryptedAll = SafeStorageCrypto.decryptAllKeys(encryptedAll);
  assert(decryptedAll.groq === 'gsk_key1', 'groq round-trip correcto');
  assert(decryptedAll.gemini === 'AIzaSyAnotherKey', 'gemini round-trip correcto');
  assert(decryptedAll.openai === 'sk-key3', 'openai round-trip correcto');

  // ── Test 4: safeStorage no disponible → fallback a texto plano ───────────
  console.log(C.cyan('\n── Test 4: safeStorage no disponible → texto plano ────'));
  SafeStorageCrypto._setSafeStorage(makeUnavailableSafeStorage());
  assert(!SafeStorageCrypto.isAvailable(), 'safeStorage no disponible con mock');

  const plainKey = 'gsk_plaintext_key';
  const notEncrypted = SafeStorageCrypto.encrypt(plainKey);
  assert(notEncrypted === plainKey, 'encrypt sin safeStorage devuelve texto plano');

  const notDecrypted = SafeStorageCrypto.decrypt(notEncrypted);
  assert(notDecrypted === plainKey, 'decrypt sin safeStorage devuelve texto plano');

  // ── Test 5: empty/null values ────────────────────────────────────────────
  console.log(C.cyan('\n── Test 5: edge cases ──────────────────────────────────'));
  SafeStorageCrypto._setSafeStorage(makeMockSafeStorage());
  assert(SafeStorageCrypto.encrypt('') === '', 'encrypt string vacío → vacío');
  assert(SafeStorageCrypto.encrypt(null) === null, 'encrypt null → null');
  assert(SafeStorageCrypto.encrypt(undefined) === undefined, 'encrypt undefined → undefined');
  assert(SafeStorageCrypto.decrypt('') === '', 'decrypt string vacío → vacío');
  assert(SafeStorageCrypto.decrypt(null) === null, 'decrypt null → null');

  // ── Test 6: config.json simulation — key no aparece en texto plano ──────
  console.log(C.cyan('\n── Test 6: config.json — key cifrada, no en texto plano ─'));
  SafeStorageCrypto._setSafeStorage(makeMockSafeStorage());
  const configApiKeys = { groq: SafeStorageCrypto.encrypt('gsk_real_key_abc') };
  const configJson = JSON.stringify({ llm: { apiKeys: configApiKeys } });
  assert(
    !configJson.includes('gsk_real_key_abc'),
    'la key real NO aparece en el JSON serializado',
    `json: ${configJson.slice(0, 120)}...`
  );
  assert(configJson.includes('enc:v1:'), 'el JSON contiene el prefijo cifrado');

  // Leer la key de vuelta
  const readBack = SafeStorageCrypto.decrypt(configApiKeys.groq);
  assert(readBack === 'gsk_real_key_abc', 'la key se descifra correctamente desde config');

  // ── Test 7: compatibilidad — config vieja con key en texto plano ─────────
  console.log(C.cyan('\n── Test 7: config vieja (key en texto plano) se lee ───'));
  const legacyConfig = { llm: { apiKeys: { groq: 'gsk_legacy_plaintext' } } };
  const legacyDecrypted = SafeStorageCrypto.decrypt(legacyConfig.llm.apiKeys.groq);
  assert(
    legacyDecrypted === 'gsk_legacy_plaintext',
    'key legacy sin prefijo se descifra (se devuelve tal cual)'
  );

  // ── Resumen ─────────────────────────────────────────────────────────────
  console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
  console.log(
    C.bold(
      `  SafeStorageCrypto: ${C.green(`${passed} passed`)}  ${failed > 0 ? C.red(`${failed} failed`) : C.dim('0 failed')}  / ${passed + failed} total`
    )
  );
  console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((e) => {
  console.error(C.red(`\n${e.message}\n${e.stack}`));
  process.exitCode = 1;
});
