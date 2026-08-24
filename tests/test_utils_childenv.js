// @ts-nocheck
'use strict';
// test_utils_childenv.js — política única de env para procesos hijos:
// safeChildEnv (estándar, sin credenciales) y minimalChildEnv (terceros,
// solo PATH/HOME + extra). Casos de seguridad son los críticos acá.

const assert = require('assert');
let passed = 0;
const t = (c, m) => { assert(c, m); passed++; console.log('  ✓', m); };

const { safeChildEnv, minimalChildEnv, STRIPPED_ENV_KEY_RE } = require('../core/utils/childEnv.js');

function main() {
  console.log('\n── safeChildEnv ──');

  // Camino feliz: conserva útiles y variables normales.
  process.env.CHILDENV_TEST_PLAIN = 'visible';
  const env = safeChildEnv();
  t(!!env.PATH && !!env.HOME, 'conserva PATH y HOME');
  t(env.CHILDENV_TEST_PLAIN === 'visible', 'conserva variables normales');

  // Borde de seguridad: credenciales eliminadas por patrón de nombre.
  process.env.MY_API_KEY = 'secreto';
  process.env.GITHUB_TOKEN = 'tok';
  process.env.DB_PASSWORD = 'pw';
  process.env.OAUTH_SECRET = 'sec';
  const stripped = safeChildEnv();
  t(stripped.MY_API_KEY === undefined, 'MY_API_KEY eliminada');
  t(stripped.GITHUB_TOKEN === undefined, 'GITHUB_TOKEN eliminada');
  t(stripped.DB_PASSWORD === undefined, 'DB_PASSWORD eliminada');
  t(stripped.OAUTH_SECRET === undefined, 'OAUTH_SECRET eliminada');

  // El regex cubre prefijo/sufijo/infix con separadores.
  t(STRIPPED_ENV_KEY_RE.test('API_KEY') === true, 'regex: API_KEY');
  t(STRIPPED_ENV_KEY_RE.test('KEY_API') === true, 'regex: KEY_API (prefijo)');
  t(STRIPPED_ENV_KEY_RE.test('MONKEY_BUSINESS') === false, 'regex: MONKEY no falso positivo');
  t(STRIPPED_ENV_KEY_RE.test('TOKENIZE_MODE') === true || STRIPPED_ENV_KEY_RE.test('TOKENIZE_MODE') === false, 'regex ejecutable');

  // Borde: extra gana sobre process.env y sobre el stripping.
  const withExtra = safeChildEnv({ MY_API_KEY: 'explicito', EXTRA_VAR: 'x' });
  t(withExtra.MY_API_KEY === 'explicito', 'extra gana sobre stripping');
  t(withExtra.EXTRA_VAR === 'x', 'extra se incluye');

  // Borde: valores undefined en extra se ignoran.
  const undefExtra = safeChildEnv({ VOID: undefined });
  t(undefExtra.VOID === undefined, 'extra undefined ignorado');

  delete process.env.CHILDENV_TEST_PLAIN;
  delete process.env.MY_API_KEY;
  delete process.env.GITHUB_TOKEN;
  delete process.env.DB_PASSWORD;
  delete process.env.OAUTH_SECRET;

  console.log('\n── minimalChildEnv ──');

  process.env.SOME_RANDOM_VAR = 'no-debe-pasar';
  process.env.ANOTHER_TOKEN = 'no';

  const mini = minimalChildEnv();
  t(!!mini.PATH, 'incluye PATH');
  t(mini.SOME_RANDOM_VAR === undefined, 'NO hereda variables del proceso');
  t(mini.ANOTHER_TOKEN === undefined, 'nunca arrastra tokens del proceso');
  t(Object.keys(mini).every((k) => ['PATH', 'HOME'].includes(k)), 'solo PATH/HOME sin extra');

  const miniExtra = minimalChildEnv({ MODEL_PATH: '/models/x', EMPTY: undefined });
  t(miniExtra.MODEL_PATH === '/models/x', 'extra explícito incluido');
  t(miniExtra.EMPTY === undefined, 'extra undefined ignorado');

  delete process.env.SOME_RANDOM_VAR;
  delete process.env.ANOTHER_TOKEN;

  console.log(`\nResultado: ${passed} passed`);
}

main();
