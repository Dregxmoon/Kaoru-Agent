'use strict';

// LanguageProfile: el sistema muta según el usuario, sin ramas por idioma.
// La detección es genérica (scripts Unicode + stopwords mínimos de detección);
// el comportamiento (tools, protocolo, decisiones) jamás se ramifica por idioma.

const {
  detectLanguage,
  localeFor,
  responseLanguageLine,
  DEFAULT_CODE,
} = require('../core/grounding/LanguageProfile.js');

let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
    passed++;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

console.log('\x1b[1m\n════ LanguageProfile (multilenguaje por inferencia) ════\x1b[0m');

console.log('\n── Detección por escritura (genérica, sin listas) ──');
assert(detectLanguage('アマゾンで漫画を探して').code === 'ja', 'japonés por kana');
assert(detectLanguage('아마존에서 만화를 찾아줘').code === 'ko', 'coreano por hangul');
assert(detectLanguage('在亚马逊上找漫画').code === 'zh', 'chino por han');
assert(detectLanguage('найди мангу на амазоне').code === 'ru', 'ruso por cirílico');

console.log('\n── Detección latina por stopwords ──');
assert(detectLanguage('abre amazon y busca el manga por favor').code === 'es', 'español');
assert(detectLanguage('open amazon and find the manga please').code === 'en', 'inglés');
assert(detectLanguage('abre o amazon para encontrar o mangá').code === 'pt', 'portugués');
assert(detectLanguage('ouvre amazon et cherche le manga s’il vous plaît').code === 'fr', 'francés');

console.log('\n── Override del usuario siempre gana ──');
assert(
  detectLanguage('open amazon please', { override: 'ja' }).code === 'ja',
  'preferencia fijada gana al texto'
);
assert(
  detectLanguage('open amazon please', { override: 'xx' }).code === 'en',
  'override inválido se ignora (sigue inferencia)'
);

console.log('\n── Default seguro ──');
const empty = detectLanguage('');
assert(empty.code === DEFAULT_CODE && empty.confidence === 0, 'vacío → default sin confianza');
const gibberish = detectLanguage('xkzq wvfp 1234');
assert(gibberish.code === DEFAULT_CODE, 'sin señal → default español');

console.log('\n── Datos derivados (una tabla, sin ramas) ──');
assert(localeFor('ja').ttsVoice === 'ja-JP-NanamiNeural', 'voz japonesa (la actual por defecto)');
assert(localeFor('es').locale === 'es-MX', 'locale español');
assert(localeFor('xx').locale === 'es-MX', 'código desconocido cae al default');
assert(
  Array.isArray(localeFor('en').tldHints) && localeFor('en').tldHints.includes('com'),
  'pistas de TLD para scoring del resolver'
);

console.log('\n── Línea de idioma para el prompt ──');
const line = responseLanguageLine(detectLanguage('open amazon please'));
assert(/inglés|en/.test(line) && /canonical English/.test(line), 'ordena responder en inglés');
assert(/never changes the tool protocol/.test(line), 'el protocolo no muta con el idioma');

console.log(`\nResultado: ${passed} passed  ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
