const LLM = require('/home/panfilo/Projects/kaoru-agent/core/llm/LLMProvider.js');
const strip = (t) => LLM._debug_stripForbiddenPhrases(t);
const assert = (c, m) => { if (!c) { console.error('✗', m); process.exitCode = 1; } else console.log('✓', m); };

// caso real del usuario
const real = '¡Genial! Así tendemos un rato relajado 😄 ¿buscamos un meme? 😎✨';
const out1 = strip(real);
assert(!/\p{Extended_Pictographic}/u.test(out1), 'caso real: cero emojis tras filtrar → ' + JSON.stringify(out1));

// banderas, keycaps, secuencias ZWJ
const out2 = strip('hola 🇦🇷 mundo 👍‍🔥 y 5️⃣ fin');
assert(!/\p{Extended_Pictographic}/u.test(out2) && !/[\u{1F3FB}-\u{1F3FF}]/u.test(out2), 'banderas/ZWJ/keycaps eliminadas');

// texto limpio intacto
const clean = '**Hola** — ¿cómo va el `código`?';
assert(strip(clean) === clean, 'markdown/código sin emojis NO se toca');

// acentos y ñ intactos
const acc = '¿Qué pasó con ñandú, árboles y corazón?';
assert(strip(acc).includes('ñandú') && strip(acc).includes('corazón'), 'acentos/ñ preservados');
console.log('TODO OK');
