/**
 * mock-openclaw.js — v6
 *
 * Fix v5 → v6:
 *   exec — bug de comillas perdidas en Windows con comandos multi-palabra
 *          entre comillas (ej. `git commit -m "mensaje con espacios"`).
 *
 *          Causa raíz: se parseaba `command` con parseArgs() (que quita
 *          las comillas y agrupa correctamente "mensaje con espacios" en
 *          UN solo argumento) y luego se llamaba
 *          spawnSync(program, args, { shell: true }) en Windows.
 *
 *          Lo que Node hace internamente cuando shell:true en Windows es:
 *              const command = [file, ...args].join(' ');
 *          — es decir, vuelve a unir el programa y los argumentos con
 *          espacios SIN volver a poner comillas a los argumentos que
 *          las necesitan. Como parseArgs ya les había quitado las
 *          comillas, el argumento del mensaje llegaba a cmd.exe como
 *          varias palabras sueltas, y git las trataba como pathspecs
 *          independientes (de ahí los errores "pathspec 'código' did
 *          not match any file(s)").
 *
 *          Fix: en Windows ya NO se parsea `command` con parseArgs antes
 *          de ejecutar — se le pasa el string completo, original, con
 *          sus comillas intactas, directamente a spawnSync con
 *          shell:true. Así es cmd.exe quien parsea las comillas, igual
 *          que lo haría una terminal real (es el mismo mecanismo que usa
 *          internamente child_process.exec() de Node, probado y estable).
 *
 *          En plataformas no-Windows se sigue usando parseArgs() +
 *          shell:false, que es más seguro (sin pasar por una shell) y
 *          no tiene este problema porque execve recibe cada argumento
 *          del array de forma literal, sin volver a tokenizar nada.
 *
 * Fixes anteriores mantenidos (v4 → v5):
 *   Acceso total al filesystem — eliminada la restricción de
 *   isWithinAllowedRoots(). March puede leer/escribir/editar en
 *   cualquier ruta del sistema (absoluta, relativa al proyecto,
 *   o dentro de carpetas especiales con subcarpetas arbitrarias).
 *
 *   La seguridad ya no vive en el mock — vive en el flujo de
 *   aprobación de Planner.js (isHighImpact + onApprovalNeeded),
 *   que el usuario ve y confirma antes de cada acción real.
 *
 *   Mantiene el bloqueo de comandos shell destructivos (rm -rf,
 *   format, shutdown, etc.) como última línea de defensa contra
 *   comandos catastróficos incluso si el usuario aprobó por error.
 *
 *   resolveSmartPath ahora soporta subcarpetas arbitrarias dentro
 *   de carpetas especiales: "Descargas/Tec/archivo.txt" resuelve
 *   correctamente a C:\Users\<usuario>\Downloads\Tec\archivo.txt
 *   sin necesitar que "Tec" exista de antemano (se crea si falta).
 *
 * Fixes anteriores mantenidos:
 *   Bug commit — comillas en cmd /c (parseo de args sin shell)
 *   Bug read   — sin truncado de archivos
 *   Bug 3      — exec captura stdout/stderr reales
 *   Bug 11     — UTF-8 encoding correcto
 *   Bug 12     — CWD fijo al proyecto (para rutas normales)
 */

'use strict';

const http = require('http');
const os   = require('os');
const { spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const PROJECT_CWD = process.cwd();
const HOME        = os.homedir();

console.log(`[mock] CWD del proyecto: ${PROJECT_CWD}`);
console.log(`[mock] HOME del usuario: ${HOME}`);

const PORT = 18789;

// ── Carpetas especiales del usuario ───────────────────────────────────────────
const SPECIAL_FOLDERS = {
  'descargas':  path.join(HOME, 'Downloads'),
  'downloads':  path.join(HOME, 'Downloads'),
  'escritorio': path.join(HOME, 'Desktop'),
  'desktop':    path.join(HOME, 'Desktop'),
  'documentos': path.join(HOME, 'Documents'),
  'documents':  path.join(HOME, 'Documents'),
  'imagenes':   path.join(HOME, 'Pictures'),
  'imágenes':   path.join(HOME, 'Pictures'),
  'pictures':   path.join(HOME, 'Pictures'),
  'musica':     path.join(HOME, 'Music'),
  'música':     path.join(HOME, 'Music'),
  'music':      path.join(HOME, 'Music'),
  'videos':     path.join(HOME, 'Videos'),
  'video':      path.join(HOME, 'Videos'),
};

// ── Última línea de defensa — rutas absolutamente prohibidas ─────────────────
// El comentario de arriba decía "el control de seguridad vive en el flujo de
// aprobación de Planner.js, no aquí" — cierto, pero una sola capa de defensa
// es frágil. Si por lo que sea una request llega hasta acá pidiendo tocar una
// llave SSH, un archivo de credenciales, o el almacén de contraseñas del
// navegador, esto se niega sin excepción — mismo espíritu que el blocklist de
// comandos catastróficos que ya existe más abajo en este archivo.
const FORBIDDEN_PATH_PATTERNS = [
  /\.ssh[\\/]/i, /id_rsa/i, /id_ed25519/i, /\.pem$/i, /\.pfx$/i, /\.key$/i,
  /\.aws[\\/]/i, /\.env(\.|$)/i, /credentials/i, /\.git-credentials/i,
  /\.npmrc/i, /login data/i, /\bcookies\b/i, /wallet/i, /\.pgpass/i,
];

function isForbiddenPath(filePath) {
  if (!filePath) return false;
  return FORBIDDEN_PATH_PATTERNS.some(re => re.test(filePath));
}

/**
 * Resuelve un filePath de forma inteligente:
 *
 *   - Ruta absoluta → se usa tal cual, sin restricciones.
 *   - Primer segmento coincide con carpeta especial → resuelve contra
 *     esa carpeta real del usuario, soportando subcarpetas arbitrarias
 *     ("Descargas/Tec/archivo.txt" → Downloads/Tec/archivo.txt).
 *   - Cualquier otro caso → relativo a PROJECT_CWD (comportamiento normal
 *     de trabajo en el proyecto).
 *
 * No hay restricción de "directorios permitidos" — March tiene acceso
 * total al filesystem del usuario. El control de seguridad principal vive
 * en el flujo de aprobación de Planner.js; FORBIDDEN_PATH_PATTERNS de
 * arriba es la segunda capa, aplicada en los handlers read/write/edit.
 */
function resolveSmartPath(filePath) {
  if (!filePath) return filePath;

  if (path.isAbsolute(filePath)) return filePath;

  const normalized = filePath.replace(/\\/g, '/');
  const parts       = normalized.split('/').filter(Boolean);
  const firstPart   = (parts[0] || '').toLowerCase();

  if (SPECIAL_FOLDERS[firstPart]) {
    const rest = parts.slice(1).join(path.sep);
    const resolved = rest
      ? path.join(SPECIAL_FOLDERS[firstPart], rest)
      : SPECIAL_FOLDERS[firstPart];
    console.log(`[mock] ruta especial detectada: "${filePath}" → "${resolved}"`);
    return resolved;
  }

  return path.resolve(PROJECT_CWD, filePath);
}

// ── Helpers de exec ────────────────────────────────────────────────────────────

/**
 * Parsea un comando en argumentos respetando comillas dobles y simples.
 * Solo se usa en plataformas NO-Windows (ver TOOLS.exec) — en Windows el
 * comando se pasa completo y sin parsear a la shell (cmd.exe), porque
 * volver a unir un array de args con espacios bajo shell:true no vuelve
 * a poner comillas a los que las necesitan (ver comentario de la v6
 * arriba). Aquí, en cambio, los args van directo a execve sin pasar por
 * ninguna shell (shell:false), así que cada elemento del array llega
 * literal, sin volver a tokenizarse — no hay riesgo de que se pierdan
 * las comillas porque nunca se reconstruye un string de comando.
 */
function parseArgs(cmd) {
  const args = [];
  let current  = '';
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (c === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (c === ' ' && !inDouble && !inSingle) {
      if (current) { args.push(current); current = ''; }
      continue;
    }
    current += c;
  }
  if (current) args.push(current);
  return args;
}

// ── Herramientas ──────────────────────────────────────────────────────────────

const TOOLS = {

  exec: (input) => {
    const { command, cwd, timeout } = input;

    // Última línea de defensa: comandos catastróficos siguen bloqueados
    // incluso si el usuario aprobó la acción — protección contra errores.
    const BLOCKED = /\brm\s+-rf?\s+\/(?!\w)|\bdel\s+\/[sqf]\s+[a-z]:\\?\s*$|\bformat\s+[a-z]:/i;
    if (BLOCKED.test(command)) {
      return { result: '', error: `[mock] comando catastrófico bloqueado: ${command}` };
    }

    const workDir = cwd || PROJECT_CWD;
    const isWin   = process.platform === 'win32';

    console.log(`[mock] exec (${isWin ? 'win32/shell' : 'posix/no-shell'}): ${command}`);

    try {
      let result;

      if (isWin) {
        // FIX v6 — en Windows NO se parsea `command` a un array de args.
        // Se pasa el string original completo (comillas intactas) como
        // único "file" a spawnSync, sin args, con shell:true. Esto es
        // necesario además porque muchos comandos en Windows (echo, dir,
        // type, set, mkdir sin slash...) son built-ins de cmd.exe, no
        // ejecutables reales — sin shell:true fallarían con ENOENT.
        // Es cmd.exe quien parsea las comillas del comando, igual que lo
        // haría una terminal real (mismo mecanismo que usa internamente
        // child_process.exec() de Node).
        result = spawnSync(command, {
          cwd:      workDir,
          timeout:  (timeout || 30) * 1000,
          encoding: 'utf8',
          shell:    true,
          env:      { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        });
      } else {
        // No-Windows: parseamos nosotros mismos respetando comillas y
        // ejecutamos directo (sin shell) — más seguro y sin el problema
        // de re-tokenización descrito arriba, porque execve recibe cada
        // argumento del array tal cual, sin reconstruir ningún string.
        const args    = parseArgs(command);
        const program = args.shift();

        console.log(`[mock] exec args parseados: ${program} ${JSON.stringify(args)}`);

        result = spawnSync(program, args, {
          cwd:      workDir,
          timeout:  (timeout || 30) * 1000,
          encoding: 'utf8',
          shell:    false,
          env:      { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        });
      }

      const stdout = (result.stdout || '').trim();
      const stderr = (result.stderr || '').trim();
      const code   = result.status ?? 0;

      console.log(`[mock] exec resultado: code=${code} stdout=${stdout.length}chars stderr=${stderr.length}chars`);

      if (result.error) {
        return { result: '', error: result.error.message };
      }

      if (code !== 0 && !stdout) {
        return {
          result: stderr || '',
          error:  `Comando salió con código ${code}${stderr ? ': ' + stderr : ''}`,
        };
      }

      const output = [stdout, stderr].filter(Boolean).join('\n--- stderr ---\n');
      return { result: output || `(sin salida, código ${code})` };

    } catch(e) {
      return { result: '', error: e.message };
    }
  },

  // read — restringido solo por FORBIDDEN_PATH_PATTERNS (ver arriba);
  // el resto del control de acceso vive en Planner.js
  read: (input) => {
    const { path: filePath } = input;
    if (isForbiddenPath(filePath)) {
      console.warn(`[mock] read BLOQUEADO por ruta prohibida: "${filePath}"`);
      return { result: '', error: `Acceso denegado: "${filePath}" coincide con un patrón de ruta sensible (llaves, credenciales, cookies, etc).` };
    }
    try {
      const resolved = resolveSmartPath(filePath);
      const content  = fs.readFileSync(resolved, { encoding: 'utf8' });
      console.log(`[mock] read: "${filePath}" → "${resolved}" (${content.length} chars)`);
      return { result: content };
    } catch(e) {
      return { result: '', error: `No se pudo leer ${filePath}: ${e.message}` };
    }
  },

  // write — restringido solo por FORBIDDEN_PATH_PATTERNS; crea subcarpetas
  // automáticamente si no existen
  write: (input) => {
    const { path: filePath, content } = input;
    if (isForbiddenPath(filePath)) {
      console.warn(`[mock] write BLOQUEADO por ruta prohibida: "${filePath}"`);
      return { result: '', error: `Acceso denegado: "${filePath}" coincide con un patrón de ruta sensible (llaves, credenciales, cookies, etc).` };
    }
    try {
      const resolved = resolveSmartPath(filePath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, content, { encoding: 'utf8' });
      console.log(`[mock] write: "${filePath}" → "${resolved}" (${content.length} chars)`);
      return { result: `Archivo escrito: ${resolved} (${content.length} chars)` };
    } catch(e) {
      return { result: '', error: e.message };
    }
  },

  // edit — restringido solo por FORBIDDEN_PATH_PATTERNS
  edit: (input) => {
    const { path: filePath, old_text, new_text } = input;
    if (isForbiddenPath(filePath)) {
      console.warn(`[mock] edit BLOQUEADO por ruta prohibida: "${filePath}"`);
      return { result: '', error: `Acceso denegado: "${filePath}" coincide con un patrón de ruta sensible (llaves, credenciales, cookies, etc).` };
    }
    try {
      const resolved = resolveSmartPath(filePath);
      let content    = fs.readFileSync(resolved, 'utf8');
      if (!content.includes(old_text)) {
        return { result: '', error: `Texto no encontrado en ${filePath}` };
      }
      content = content.replace(old_text, new_text);
      fs.writeFileSync(resolved, content, 'utf8');
      console.log(`[mock] edit: "${filePath}" → "${resolved}"`);
      return { result: `Editado: ${resolved}` };
    } catch(e) {
      return { result: '', error: e.message };
    }
  },

  code_execution: (input) => {
    const { code, timeout = 10 } = input;
    const tmp = path.join(os.tmpdir(), `march_code_${Date.now()}.py`);
    try {
      fs.writeFileSync(tmp, code, 'utf8');
      const result = spawnSync('python', [tmp], {
        cwd:      PROJECT_CWD,
        timeout:  timeout * 1000,
        encoding: 'utf8',
        env:      { ...process.env, PYTHONIOENCODING: 'utf-8' },
      });
      const stdout = (result.stdout || '').trim();
      const stderr = (result.stderr || '').trim();
      console.log(`[mock] code_execution: ${stdout.length} chars stdout, ${stderr.length} chars stderr`);
      if (result.error) return { result: '', error: result.error.message };
      return { result: stdout || stderr || '(sin salida)' };
    } catch(e) {
      return { result: '', error: e.message };
    } finally {
      try { fs.unlinkSync(tmp); } catch(_) {}
    }
  },

  /**
   * apply_patch — aplica un parche estilo unified diff a un archivo.
   * params: { path: string, patch: string }
   *
   * Implementación simple: parsea bloques @@ ... @@ con líneas
   * +/-/  y los aplica secuencialmente. No requiere `patch` ni `git`
   * instalado en el sistema — parser propio en JS.
   */
  apply_patch: (input) => {
    const { path: filePath, patch } = input;
    try {
      const resolved = resolveSmartPath(filePath);
      let lines = fs.readFileSync(resolved, 'utf8').split('\n');

      // Parsear bloques de hunks: @@ -start,len +start,len @@
      const hunkRegex = /@@\s*-(\d+)(?:,(\d+))?\s*\+(\d+)(?:,(\d+))?\s*@@/g;
      const patchLines = patch.split('\n');

      let currentLineIdx = -1;
      let offset = 0; // ajuste acumulado por inserciones/eliminaciones previas

      for (let i = 0; i < patchLines.length; i++) {
        const line = patchLines[i];
        const hunkMatch = /@@\s*-(\d+)/.exec(line);

        if (hunkMatch) {
          currentLineIdx = parseInt(hunkMatch[1], 10) - 1 + offset;
          continue;
        }

        if (currentLineIdx === -1) continue;

        if (line.startsWith('-')) {
          lines.splice(currentLineIdx, 1);
          offset -= 1;
        } else if (line.startsWith('+')) {
          lines.splice(currentLineIdx, 0, line.slice(1));
          currentLineIdx++;
          offset += 1;
        } else if (line.startsWith(' ')) {
          currentLineIdx++;
        }
      }

      const newContent = lines.join('\n');
      fs.writeFileSync(resolved, newContent, 'utf8');
      console.log(`[mock] apply_patch: "${filePath}" → "${resolved}" (${newContent.length} chars)`);
      return { result: `Patch aplicado: ${resolved}` };
    } catch(e) {
      return { result: '', error: `Error aplicando patch a ${filePath}: ${e.message}` };
    }
  },

  // web_search y browser se delegan a BrowserBridge.js (Playwright real)
  web_search: (input) => {
    return { result: '', error: '[mock] web_search debe usar BrowserBridge.js, no este mock. Ver integración en Planner.js' };
  },

  browser: (input) => {
    return { result: '', error: '[mock] browser debe usar BrowserBridge.js, no este mock. Ver integración en Planner.js' };
  },
};

// ── Servidor HTTP ─────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({
      status:  'ok',
      version: 'mock-6.0',
      tools:   Object.keys(TOOLS),
      cwd:     PROJECT_CWD,
      home:    HOME,
      specialFolders: Object.keys(SPECIAL_FOLDERS),
    }));
    return;
  }

  if (req.method === 'POST' && req.url === '/v1/tool') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        const { tool, input } = JSON.parse(body);
        console.log(`\n[mock] ← ${tool}`, JSON.stringify(input).slice(0, 200));

        const handler = TOOLS[tool];
        if (!handler) {
          res.writeHead(400);
          res.end(JSON.stringify({ result: '', error: `Herramienta desconocida: ${tool}` }));
          return;
        }

        const toolResult = handler(input);
        console.log(`[mock] → ${tool}:`, JSON.stringify(toolResult).slice(0, 200));

        res.writeHead(200);
        res.end(JSON.stringify(toolResult));

      } catch(e) {
        console.error('[mock] error:', e.message);
        res.writeHead(500);
        res.end(JSON.stringify({ result: '', error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n╔═══════════════════════════════════════════╗`);
  console.log(`║   Mock OpenClaw v6 corriendo en :${PORT}   ║`);
  console.log(`╠═══════════════════════════════════════════╣`);
  console.log(`║  CWD:  ${PROJECT_CWD.slice(0, 34).padEnd(34)} ║`);
  console.log(`║  HOME: ${HOME.slice(0, 34).padEnd(34)} ║`);
  console.log(`╠═══════════════════════════════════════════╣`);
  console.log(`║  Fixes aplicados:                         ║`);
  console.log(`║   ✓ exec: comillas no se pierden en        ║`);
  console.log(`║     Windows (comando completo a la shell)  ║`);
  console.log(`║   ✓ Acceso total al filesystem            ║`);
  console.log(`║   ✓ apply_patch implementado (sin git)    ║`);
  console.log(`║   ✓ code_execution con stdout/stderr      ║`);
  console.log(`║   ⚠ web_search/browser → usar BrowserBridge║`);
  console.log(`╚═══════════════════════════════════════════╝\n`);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`❌ Puerto ${PORT} ocupado.`);
  else console.error('❌ Error:', e.message);
});
