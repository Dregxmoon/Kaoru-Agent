'use strict';

const path = require('path');

let PROJECT_CWD = process.cwd();

function setProjectCWD(cwd) {
  if (cwd && typeof cwd === 'string') {
    PROJECT_CWD = cwd;
  }
}

const HIGH_IMPACT_PATTERNS = [
  /\brm\s+-rf?\b/i,
  /\bdel\s+\/[sqf]/i,
  /\bformat\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bpoweroff\b/i,
  /\bkill\s+-9\b/,
  /C:\\Windows\\/i,
  /\/etc\//,
  /\/sys\//,
  /\/boot\//,
  /\b(curl|wget)\b.*\|\s*(sh|bash|zsh)\b/i,
  /\biwr\b|\binvoke-webrequest\b/i,
  /\biex\b|\binvoke-expression\b/i,
  /-encodedcommand\b/i,
  /\bcertutil\b.*-urlcache/i,
  /\bmshta\b/i,
  /\b(printenv|env)\b\s*$/i,
  /\bschtasks\b/i,
  /\breg\s+(add|delete)\b/i,
  /\bnew-service\b|\bsc\s+create\b/i,
  /disable.*defender/i,
  /disable.*firewall/i,
  /netsh\s+advfirewall/i,
  /\bgit\s+push\s+.*--force/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\b(npm|pnpm|yarn)\s+install\b/i,
  /\bpip\s+install\b/i,
];

// Lista de comandos de solo lectura conocidos — la ÚNICA forma en que un
// exec se ejecuta SIN pedir aprobación. Esto es intencional al revés de
// como estaba antes: antes, exec corría libre salvo que matcheara un
// patrón peligroso conocido (evadible con ofuscación, ver nota en
// openclaw-server.js). Ahora, exec pide aprobación salvo que matchee algo
// explícitamente reconocido como inofensivo — un bypass del blocklist ya
// no logra nada, porque el blocklist dejó de ser la puerta.
// Cada patrón exige que el comando completo (después de recortar espacios)
// empiece con el binario esperado y no encadene con ; && || | (evita que
// "ls; rm -rf /" se cuele disfrazado de comando seguro).
const SAFE_READONLY_PATTERNS = [
  /^ls(\s+-[a-zA-Z]+)*(\s+\S+)?$/,
  /^pwd$/,
  /^whoami$/,
  /^date(\s+\S+)*$/,
  /^echo\s+[^;&|`$()]*$/,
  /^cat\s+[^;&|`$()>]+$/,
  /^head(\s+-n\s*\d+)?\s+[^;&|`$()>]+$/,
  /^tail(\s+-n\s*\d+)?\s+[^;&|`$()>]+$/,
  /^wc(\s+-[a-zA-Z]+)*\s+[^;&|`$()>]+$/,
  /^which\s+[^;&|`$()]+$/,
  /^uname(\s+-[a-zA-Z]+)*$/,
  /^git\s+(status|log|diff|remote\s+-v|show|blame)(\s+[^;&|`$()]*)?$/,
  // `git branch` SOLO en modo listado de solo lectura: sin args, -a/-r/--all
  // o --list con un patrón. Nunca con -d/-D/--delete ni con un nombre de
  // rama a secas (que CREA la rama). Un "git branch -D main" o "git branch
  // feature" desde el LLM ahora pide aprobación.
  /^git\s+branch$/,
  /^git\s+branch\s+(-a|-r|--all|--list)$/,
  /^git\s+branch\s+--list\s+[A-Za-z0-9_*?./-]+$/,
  /^node\s+(-v|--version)$/,
  /^npm\s+(-v|--version)$/,
  /^python3?\s+(-V|--version)$/,
  /^grep\s+[^;&|`$()>]+$/,
];

function _isSafeReadonlyCommand(command) {
  if (!command || typeof command !== 'string') return false;
  const trimmed = command.trim();
  return SAFE_READONLY_PATTERNS.some((re) => re.test(trimmed));
}

const SENSITIVE_PATH_PATTERNS = [
  /\.ssh[\\/]/i,
  /id_rsa/i,
  /id_ed25519/i,
  /\.pem$/i,
  /\.pfx$/i,
  /\.key$/i,
  /\.aws[\\/]/i,
  /\.env(\.|$)/i,
  /credentials/i,
  /\.git-credentials/i,
  /\.npmrc/i,
  /login data/i,
  /\bcookies\b/i,
  /wallet/i,
  /\.pgpass/i,
];

function _isSensitivePath(p) {
  if (!p || typeof p !== 'string') return false;
  return SENSITIVE_PATH_PATTERNS.some((re) => re.test(p));
}

function _isOutsideProject(p) {
  if (!p || typeof p !== 'string') return false;
  try {
    const resolved = path.isAbsolute(p) ? p : path.join(PROJECT_CWD, p);
    const rel = path.relative(PROJECT_CWD, resolved);
    return rel.startsWith('..') || path.isAbsolute(rel);
  } catch (_) {
    return true;
  }
}

function isHighImpact(tool, params) {
  if (_isSensitivePath(params?.path) || _isSensitivePath(params?.command)) return true;

  if (tool === 'exec' && params.command) return !_isSafeReadonlyCommand(params.command);

  if (tool === 'write' && params.path)
    return (
      _isSensitivePath(params.path) ||
      HIGH_IMPACT_PATTERNS.some((p) => p.test(params.path)) ||
      _isOutsideProject(params.path)
    );

  if (tool === 'edit' && params.path)
    return _isSensitivePath(params.path) || _isOutsideProject(params.path);

  if (tool === 'read' && params.path) return _isOutsideProject(params.path);

  if (tool === 'browser') return true;

  if (tool === 'edit_file') return true;
  if (tool === 'create_file') return true;
  if (tool === 'apply_patch') return true;
  if (tool === 'code_execution') return true;

  if (tool === 'mcp') return true;

  // ── Plugins: ejecutan código arbitrario del usuario, default = preguntar ──
  if (tool === 'plugin' || (typeof tool === 'string' && tool.startsWith('plugin.'))) return true;

  // ── Git / GitHub nativos (§10): mutadores requieren aprobación ──────────
  if (tool === 'git_commit' || tool === 'git_merge' || tool === 'git_rebase') return true;
  if (tool === 'git_push') return true;
  if (tool === 'git_stash') return params?.action !== 'list';
  if (tool === 'github_issue_create') return true;
  if (tool === 'github_issue_comment') return true;
  if (tool === 'github_issue_close') return true;
  if (tool === 'github_pr_create') return true;
  if (tool === 'github_pr_review') return true;

  return false;
}

function _cleanPath(raw) {
  return (raw || '')
    .trim()
    .replace(/^[*_`"']+/, '')
    .replace(/[*_`"'.,;:!?]+$/, '')
    .trim();
}

function _cleanCommand(raw) {
  if (!raw) return '';
  let cmd = raw.trim();

  if (cmd.length >= 2) {
    const first = cmd[0];
    const last = cmd[cmd.length - 1];
    if ((first === '`' || first === '"' || first === "'") && first === last) {
      cmd = cmd.slice(1, -1).trim();
    } else if (first === '`') {
      cmd = cmd.replace(/^`+/, '').trim();
    }
  }

  const NARRATIVE_STARTS = [
    /^el\s+comando(?!\s+(?:git|npm|pip|node|python|cd|ls|dir|echo|curl|yarn|npx))\s*/i,
    /^proporcionado\b/i,
    /^que\s+se\s+/i,
    /^para\s+/i,
    /^lo\s+siguiente\s*:/i,
    /^ahora\s+voy\s+/i,
    /^voy\s+a\s+/i,
    /^listo\b/i,
  ];
  for (const p of NARRATIVE_STARTS) {
    if (p.test(cmd)) return '';
  }

  const firstNewline = cmd.search(/\r?\n/);
  if (firstNewline !== -1) cmd = cmd.slice(0, firstNewline);
  cmd = cmd.replace(/\s+ejecutar:\s*.*$/i, '');

  cmd = cmd.replace(/\t+/g, ' ');
  cmd = cmd.replace(/\s{2,}/g, ' ').trim();

  cmd = _trimNarrativeOutsideQuotes(cmd);

  cmd = cmd.replace(/[,;:!?]+$/, '').trim();

  cmd = cmd.replace(/`/g, '').trim();

  const doubleQuotes = (cmd.match(/"/g) || []).length;
  if (doubleQuotes % 2 !== 0) cmd = cmd + '"';

  return cmd.length < 2 ? '' : cmd;
}

function _trimNarrativeOutsideQuotes(cmd) {
  const QUOTE_SPLIT = /("[^"]*"|'[^']*')/g;
  const segments = cmd.split(QUOTE_SPLIT).filter((s) => s !== undefined);

  const NARRATIVE_TAIL_RULES = [
    /\.\s+[A-ZÁÉÍÓÚ][a-z].*$/,
    /\s+para\s+(?:ver|listar|asegurar|verificar|comprobar|ejecutar).*$/i,
    /\s+y\s+(?:dime|ver|ejecutar|listar).*$/i,
    /\s+en\s+(?:la\s+)?(?:terminal|consola|shell|línea\s+de\s+comandos).*$/i,
    /\s+en\s+(?:el\s+)?(?:directorio|carpeta|sistema|servidor).*$/i,
  ];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const isQuoted = /^"[^"]*"$/.test(seg) || /^'[^']*'$/.test(seg);
    if (isQuoted) continue;

    let cleaned = seg;
    for (const rule of NARRATIVE_TAIL_RULES) {
      cleaned = cleaned.replace(rule, '');
    }
    segments[i] = cleaned;

    if (cleaned.length < seg.length && i < segments.length - 1) {
      if (cleaned.trim() === '') {
        return segments
          .slice(0, i + 1)
          .join('')
          .trim();
      }
    }
  }

  return segments.join('').trim();
}

function _isValidCommand(cmd) {
  if (!cmd || cmd.length < 2) return false;

  if (/^(?:los|las|el|la|un|una|esto|estos|estas|lo|le|les|se|su|sus)\s/i.test(cmd)) return false;

  const VALID = [
    /^git\s/i,
    /^npm\s/i,
    /^pip3?\s/i,
    /^node\s/i,
    /^python\s/i,
    /^cd\s/i,
    /^ls\b/i,
    /^dir\b/i,
    /^echo\b/i,
    /^cat\s/i,
    /^type\s/i,
    /^mkdir\s/i,
    /^cp\s/i,
    /^mv\s/i,
    /^touch\s/i,
    /^curl\s/i,
    /^wget\s/i,
    /^yarn\s/i,
    /^npx\s/i,
    /^electron\b/i,
    /^code\s/i,
    /^pwsh\b/i,
    /^where\s/i,
    /^which\s/i,
    /^set\s/i,
    /^export\s/i,
  ];
  if (VALID.some((p) => p.test(cmd))) return true;

  if (/&&|\|\||[|>]/.test(cmd)) return true;

  const outsideQuotes = cmd.replace(/"[^"]*"/g, '').replace(/'[^']*'/g, '');
  if (
    /\b(voy|ahora|listo|correcto|asegurarme|verificar|antes|después|durante|luego|entonces|siguientes|comandos|archivos|cambios)\b/i.test(
      outsideQuotes
    )
  )
    return false;

  return /^[a-zA-Z0-9_\-./\\]{2,30}(\s|$)/.test(cmd) && cmd.length < 40;
}

function _isValidPath(p) {
  if (!p || p.length === 0) return false;
  return !p.includes(' ') || /\.\w{1,5}$/.test(p);
}

function _splitChainedGitCommand(raw) {
  if (!raw) return [raw];

  const SPLIT_TOKEN = /\by\s+(?=git\b)/i;
  const parts = [];
  let current = '';
  let inDouble = false;
  let inSingle = false;
  let i = 0;

  while (i < raw.length) {
    const ch = raw[i];

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      i++;
      continue;
    }

    if (!inDouble && !inSingle) {
      const rest = raw.slice(i);
      const match = SPLIT_TOKEN.exec(rest);
      if (match && match.index === 0) {
        parts.push(current.trim());
        current = '';
        i += match[0].length;
        continue;
      }
    }

    current += ch;
    i++;
  }

  if (current.trim()) parts.push(current.trim());

  return parts.length > 0 ? parts : [raw];
}

const SPECIAL_FOLDER_WORDS = [
  'descargas',
  'downloads',
  'escritorio',
  'desktop',
  'documentos',
  'documents',
  'imagenes',
  'imágenes',
  'pictures',
  'musica',
  'música',
  'music',
  'videos',
  'video',
];
const SPECIAL_FOLDER_RE = new RegExp(`\\b(${SPECIAL_FOLDER_WORDS.join('|')})\\b`, 'i');

const ACTION_DELIMITER_RE =
  /(?:\s*,\s*|\s+y\s+luego\s+|\s+y\s+entonces\s+|\s+luego\s+|\s+despu[eé]s\s+|\s+entonces\s+|\s+y\s+(?!el\s|la\s|los\s|las\s)|;|\.\s|$)/i;

function _detectFolderForCreateFile(fullText, matchEndIndex) {
  const remainder = fullText.slice(matchEndIndex);

  const delimMatch = ACTION_DELIMITER_RE.exec(remainder);
  const windowEnd = delimMatch ? delimMatch.index : remainder.length;
  const window = remainder.slice(0, windowEnd);

  const folderMatch =
    /^\s*(?:en|dentro\s+de)\s+(?:la\s+carpeta\s+|el\s+directorio\s+)?([A-Za-zÁÉÍÓÚáéíóúñÑ]+)/i.exec(
      window
    );
  if (!folderMatch) return null;

  const candidate = folderMatch[1];
  if (!SPECIAL_FOLDER_RE.test(candidate)) return null;

  return candidate;
}

function _withSpecialFolder(filename, folder) {
  if (!folder) return filename;
  const already = new RegExp(`^${folder}[\\\\/]`, 'i');
  if (already.test(filename)) return filename;
  return `${folder}/${filename}`;
}

const EDIT_VERBS_A =
  '(?:modifica(?:r)?|edita(?:r)?|cambia(?:r)?|inserta(?:r)?|' +
  'añad(?:e|ir)?|agreg(?:a|ar)?|reemplaz(?:a|ar)?|' +
  'actualiza(?:r)?|borra(?:r)?|elimina(?:r)?)';

const EDIT_PATTERN_A = new RegExp(
  EDIT_VERBS_A + '(?:[^\\n]{0,80}?)' + '([\\w][\\w./\\\\-]{0,150}\\.\\w{2,10})',
  'i'
);

const WRITE_INTENT_B = /(?:escrib(?:e|ir|o|iendo)|pon(?:er|e|ga|go)|coloca(?:r)?|guarda(?:r)?)\b/i;
const FILE_ANYWHERE = /\b([\w][\w./\\-]{0,150}\.\w{2,10})\b/g;

function _detectEditIntent(text) {
  const mA = EDIT_PATTERN_A.exec(text);
  if (mA) {
    const p = _cleanPath(mA[1]);
    if (_isValidPath(p)) return { path: p, strategy: 'A', match: mA[0] };
  }

  if (WRITE_INTENT_B.test(text)) {
    FILE_ANYWHERE.lastIndex = 0;
    let fm;
    while ((fm = FILE_ANYWHERE.exec(text)) !== null) {
      const p = _cleanPath(fm[1]);
      if (_isValidPath(p)) return { path: p, strategy: 'B', match: text };
    }
  }

  return null;
}

const ACTION_PATTERNS = [
  {
    pattern:
      /\b(git\s+(?:add|commit|push|pull|status|log|diff|branch|checkout|merge|stash|clone|init|remote|fetch|reset|rebase)(?:\s+[^\n,;]{1,200})?)/gi,
    tool: 'exec',
    buildParams: (m) => ({
      command: _cleanCommand(_splitChainedGitCommand(m[1])[0]),
      cwd: PROJECT_CWD,
    }),
    description: (m) => `Ejecutar: ${_cleanCommand(_splitChainedGitCommand(m[1])[0])}`,
    validate: (m) => _isValidCommand(_cleanCommand(_splitChainedGitCommand(m[1])[0])),
    multi: true,
    postMatches: (m) => _splitChainedGitCommand(m[1]).slice(1),
  },
  {
    pattern:
      /\b((?:npm|pip|pip3|yarn|npx)\s+(?:install|uninstall|run|start|build|test|update|init)[^\n]{0,40})/i,
    tool: 'exec',
    buildParams: (m) => ({ command: _cleanCommand(m[1]), cwd: PROJECT_CWD }),
    description: (m) => `Ejecutar: ${_cleanCommand(m[1])}`,
    validate: (m) => _isValidCommand(_cleanCommand(m[1])),
  },
  {
    pattern:
      /(?:ejecuta(?:r|ndo)?|corre(?:r)?|lanza(?:r)?)\s+(?:el\s+comando\s+)?[:-]?\s*`([^`\n]{2,120})`/i,
    tool: 'exec',
    buildParams: (m) => ({ command: _cleanCommand(m[1]), cwd: PROJECT_CWD }),
    description: (m) => `Ejecutar: ${_cleanCommand(m[1])}`,
    validate: (m) => _isValidCommand(_cleanCommand(m[1])),
  },
  {
    pattern: /Ejecutar:\s*([^\n]{2,200})/i,
    tool: 'exec',
    buildParams: (m) => ({ command: _cleanCommand(m[1]), cwd: PROJECT_CWD }),
    description: (m) => `Ejecutar: ${_cleanCommand(m[1])}`,
    validate: (m) => _isValidCommand(_cleanCommand(m[1])),
  },
  {
    pattern: /(?:lee(?:r)?|abrir?|mostrar?)\s+(?:el\s+)?archivo\s*[:-]?\s*`?([^\s`\n]{2,200})`?/i,
    tool: 'read',
    buildParams: (m) => ({ path: _cleanPath(m[1]) }),
    description: (m) => `Leer archivo: ${_cleanPath(m[1])}`,
    validate: (m) => _isValidPath(_cleanPath(m[1])),
  },
  {
    pattern:
      /crea(?:r)?\s+(?:un\s+)?(?:nuevo\s+)?(?:archivo|fichero)(?:\s+llamado|\s+named)?\s*[:-]?\s*`?([\w./\\-]+\.\w{1,10})`?/i,
    tool: 'create_file',
    buildParams: (m, fullText) => {
      const filename = _cleanPath(m[1]);
      const matchEnd = m.index + m[0].length;
      const folder = _detectFolderForCreateFile(fullText, matchEnd);
      const fullPath = _withSpecialFolder(filename, folder);
      return { path: fullPath, instruction: fullText };
    },
    description: (m, fullText) => {
      const filename = _cleanPath(m[1]);
      const matchEnd = m.index + m[0].length;
      const folder = _detectFolderForCreateFile(fullText, matchEnd);
      return `Crear archivo: ${_withSpecialFolder(filename, folder)}`;
    },
    validate: (m) => _isValidPath(_cleanPath(m[1])),
  },
  {
    pattern:
      /(?:ejecuta(?:r)?|corre(?:r)?)\s+(?:este\s+|el\s+)?c[oó]digo(?:\s+python)?\s*[:-]?\s*`([^`\n]{2,2000})`/i,
    tool: 'code_execution',
    buildParams: (m) => ({ code: m[1] }),
    description: () => `Ejecutar código Python`,
    validate: (m) => m[1] && m[1].trim().length > 0,
  },
  {
    pattern:
      /aplica(?:r)?\s+(?:este\s+|el\s+)?patch\s+a\s+([\w./\\-]+\.\w{1,10})\s*[:-]?\s*```([\s\S]{2,5000}?)```/i,
    tool: 'apply_patch',
    buildParams: (m) => ({ path: _cleanPath(m[1]), patch: m[2] }),
    description: (m) => `Aplicar patch a: ${_cleanPath(m[1])}`,
    validate: (m) => _isValidPath(_cleanPath(m[1])) && m[2] && m[2].trim().length > 0,
  },
  {
    pattern:
      /(?:busca(?:r|me)?\s+en\s+(?:la\s+)?(?:web|internet|google)|voy\s+a\s+buscar\s+en\s+(?:la\s+)?web)\s*[:-]?\s*(.+?)(?:\.|$)/i,
    tool: 'web_search',
    buildParams: (m) => ({ query: m[1].trim() }),
    description: (m) => `Buscar en la web: "${m[1].trim()}"`,
  },
  {
    pattern:
      /(?:lee(?:r)?(?:me)?|obt[ée]n(?: el contenido de)?|consulta(?:r)?)\s+(?:la\s+)?(?:url|p[áa]gina|web)?\s*(https?:\/\/[^\s\n]{2,300})/i,
    tool: 'webfetch',
    buildParams: (m) => ({ url: m[1].trim() }),
    description: (m) => `Leer URL: ${m[1].trim()}`,
  },
  {
    pattern: /busca(?:r|me)?\s+en\s+(?:duckduckgo|ddg)\s*[:-]?\s*(.+?)(?:\.|$)/i,
    tool: 'websearch',
    buildParams: (m) => ({ query: m[1].trim() }),
    description: (m) => `Buscar en DuckDuckGo: "${m[1].trim()}"`,
  },
  {
    pattern:
      /(?:navega(?:r)?\s+a|abre?\s+en\s+(?:el\s+)?navegador|visita(?:r)?)\s*[:-]?\s*(https?:\/\/[^\s\n]{2,300})/i,
    tool: 'browser',
    buildParams: (m) => ({ action: 'navigate', url: m[1].trim() }),
    description: (m) => `Navegar a: ${m[1].trim()}`,
  },
];

// Mensajes de bookkeeping del loop (resultado de una herramienta anterior) NO
// deben tratarse como instrucciones del usuario: detectar intento de edición
// sobre ellos re-dispara la misma herramienta y provoca un loop infinito.
// (p. ej. `[Resultado de herramienta "edit"]: ... Editar archivo: x.js`).
const TOOL_RESULT_MARKER_RE = /^\[(?:Resultado|ERROR) de herramienta /;

class ActionParser {
  static parse(llmResponse, userGoal) {
    const actions = [];
    const seen = new Set();
    const text = llmResponse || '';

    const isToolResult = TOOL_RESULT_MARKER_RE.test(userGoal || '');
    const editSource = userGoal && !isToolResult ? userGoal : text;
    const editIntent = _detectEditIntent(editSource);

    if (editIntent) {
      const key = `edit_file:${editIntent.path}`;
      if (!seen.has(key)) {
        seen.add(key);
        actions.push({
          tool: 'edit_file',
          params: { path: editIntent.path, instruction: editSource },
          description: `Editar archivo: ${editIntent.path}`,
          rawMatch: editIntent.match,
        });
      }
    }

    for (const {
      pattern,
      tool,
      buildParams,
      description,
      validate,
      multi,
      postMatches,
    } of ACTION_PATTERNS) {
      const sourceText = tool === 'create_file' && userGoal && !isToolResult ? userGoal : text;

      let match;
      const re = new RegExp(pattern.source, pattern.flags);
      while ((match = re.exec(sourceText)) !== null) {
        if (validate && !validate(match)) {
          if (multi) continue;
          break;
        }
        try {
          const params = buildParams(match, sourceText);
          if (tool === 'exec' && (!params.command || params.command.trim().length < 2)) {
            if (multi) continue;
            break;
          }

          const key = `${tool}:${params.command || params.path || params.query || ''}`;
          if (seen.has(key)) {
            if (multi) continue;
            break;
          }
          seen.add(key);

          actions.push({
            tool,
            params,
            description: description(match, sourceText),
            rawMatch: match[0],
          });

          if (postMatches) {
            const extras = postMatches(match, sourceText) || [];
            for (const rawExtra of extras) {
              const extraCmd = _cleanCommand(rawExtra);
              if (!extraCmd || extraCmd.trim().length < 2) continue;
              if (!_isValidCommand(extraCmd)) continue;

              const extraKey = `${tool}:${extraCmd}`;
              if (seen.has(extraKey)) continue;
              seen.add(extraKey);

              actions.push({
                tool,
                params: { command: extraCmd, cwd: PROJECT_CWD },
                description: `Ejecutar: ${extraCmd}`,
                rawMatch: rawExtra,
              });
            }
          }
        } catch (e) {
          console.warn('[action-parser] error:', e.message);
        }
        if (!multi) break;
      }
    }

    return actions;
  }
}

module.exports = {
  ActionParser,
  isHighImpact,
  setProjectCWD,
  get PROJECT_CWD() {
    return PROJECT_CWD;
  },
};
