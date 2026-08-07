// @ts-nocheck
const logger = require('../../core/observability/Logger.js');
/**
 * OSSensor.js — Fase 2 (con FIX Bug 13 + FIX tracking de tiempo en apps ignoradas)
 *
 *  Bug 13 — OSSensor reportaba "Claude" como app activa, contaminando el
 *            contexto del LLM. Se agrega "claude" y "Claude" a IGNORED_APPS
 *            para que nunca aparezca en app activa ni en ventanas abiertas.
 *            También se filtran variantes del proceso (claude.exe, Claude).
 *
 *  FIX tracking — Antes, cuando el foco caía en una app ignorada (Explorer,
 *            diálogos de sistema, etc.), _processFocus simplemente no se
 *            llamaba — pero _appStart de la app anterior NO se reseteaba.
 *            Resultado: el tiempo pasado en la app ignorada se sumaba
 *            silenciosamente a la duración de la última app real, inflando
 *            las stats de uso (getAppUsageSummary/getTodaySummary) que
 *            alimentan el contexto del asistente y el ProactiveEngine.
 *            Ahora, cuando el foco cae en una app ignorada, se guarda de
 *            inmediato el historial de la app anterior (con el tiempo
 *            correcto hasta ese momento) y se pausa el tracking hasta que
 *            el foco vuelva a una app real.
 */

const { spawn } = require('child_process');
const { BaseOSSensor } = require('./BaseOSSensor.js');
const { formatElapsed } = require('../../core/utils/format.js');

// FIX Bug 13: añadir claude y variantes a la lista de ignorados
const IGNORED_APPS = new Set([
  'explorer',
  'SearchHost',
  'ShellExperienceHost',
  'StartMenuExperienceHost',
  'LockApp',
  'LogonUI',
  'dwm',
  'taskhostw',
  'RuntimeBroker',
  'TextInputHost',
  'ApplicationFrameHost',
  'SystemSettings',
  'vtuber-overlay',
  'electron',
  'RazerAppEngine',
  'RazerCentralService',
  'RazerIngameEngine',
  'rzsd',
  'Razer Synapse',
  'RzSDKService',
  // Bug 13: ignorar Claude para evitar contaminación del contexto
  'claude',
  'Claude',
  'claude.exe',
  'Claude.exe',
  'anthropic',
  'Anthropic',
]);

// Helper para chequear si un nombre de proceso debe ignorarse
// (case-insensitive para cubrir todas las variantes)
function shouldIgnoreApp(procName) {
  if (!procName) return true;
  const lower = procName.toLowerCase();
  // Chequeo exacto (ya cubría antes)
  if (IGNORED_APPS.has(procName)) return true;
  // FIX Bug 13: chequeo case-insensitive para claude y variantes
  if (lower === 'claude' || lower.startsWith('claude.')) return true;
  // Chequeo case-insensitive para todos los ignorados
  for (const ignored of IGNORED_APPS) {
    if (ignored.toLowerCase() === lower) return true;
  }
  return false;
}

const APP_NAMES = {
  Code: 'Visual Studio Code',
  code: 'Visual Studio Code',
  cursor: 'Cursor',
  chrome: 'Google Chrome',
  msedge: 'Microsoft Edge',
  firefox: 'Firefox',
  Discord: 'Discord',
  discord: 'Discord',
  Slack: 'Slack',
  slack: 'Slack',
  WINWORD: 'Microsoft Word',
  EXCEL: 'Microsoft Excel',
  POWERPNT: 'PowerPoint',
  notion: 'Notion',
  obsidian: 'Obsidian',
  figma: 'Figma',
  Figma: 'Figma',
  spotify: 'Spotify',
  Spotify: 'Spotify',
  WhatsApp: 'WhatsApp',
  Telegram: 'Telegram',
  WindowsTerminal: 'Terminal',
  cmd: 'Símbolo del sistema',
  powershell: 'PowerShell',
  wt: 'Terminal',
  notepad: 'Bloc de notas',
  'notepad++': 'Notepad++',
  sublime_text: 'Sublime Text',
  idea64: 'IntelliJ IDEA',
  pycharm64: 'PyCharm',
  webstorm64: 'WebStorm',
  postman: 'Postman',
  insomnia: 'Insomnia',
  vlc: 'VLC',
  warp: 'Warp Terminal',
  'mpc-hc64': 'Media Player Classic',
  explorer: 'Explorador de archivos',
  SystemSettings: 'Configuración de Windows',
  // Juegos — antes no existía NINGÚN reconocimiento de juegos, así que
  // jugar (sin importar cuánto tiempo) era completamente invisible para la
  // proactividad: category caía a 'other', que ni siquiera está en
  // FOCUS_RULES de ProactiveEngine.js. Ver ese archivo para el fix
  // completo — esto es solo la mitad de "reconocer que hay un juego abierto".
  'VALORANT-Win64-Shipping': 'Valorant',
  RiotClientServices: 'Riot Client',
  'League of Legends': 'League of Legends',
  LeagueClient: 'League of Legends',
  cs2: 'Counter-Strike 2',
  csgo: 'CS:GO',
  steam: 'Steam',
  steamwebhelper: 'Steam',
  EpicGamesLauncher: 'Epic Games',
  Overwatch: 'Overwatch 2',
  'FortniteClient-Win64-Shipping': 'Fortnite',
  javaw: 'Minecraft',
};

const APP_CATEGORIES = {
  code: [
    'Code',
    'code',
    'cursor',
    'idea64',
    'pycharm64',
    'webstorm64',
    'sublime_text',
    'notepad++',
  ],
  terminal: ['WindowsTerminal', 'cmd', 'powershell', 'wt', 'warp'],
  browser: ['chrome', 'msedge', 'firefox'],
  design: ['figma', 'Figma'],
  docs: ['WINWORD', 'EXCEL', 'POWERPNT', 'notion', 'obsidian', 'notepad'],
  chat: ['Discord', 'discord', 'Slack', 'slack', 'WhatsApp', 'Telegram'],
  media: ['spotify', 'Spotify', 'vlc', 'mpc-hc64'],
  api: ['postman', 'insomnia'],
  files: ['explorer'],
  system: ['SystemSettings', 'ApplicationFrameHost'],
  game: [
    'VALORANT-Win64-Shipping',
    'RiotClientServices',
    'League of Legends',
    'LeagueClient',
    'cs2',
    'csgo',
    'steam',
    'steamwebhelper',
    'EpicGamesLauncher',
    'Overwatch',
    'FortniteClient-Win64-Shipping',
    'javaw',
  ],
};

const PS_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public class Win32 {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")]
    public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [StructLayout(LayoutKind.Sequential)]
    public struct LASTINPUTINFO {
        public uint cbSize;
        public uint dwTime;
    }
    [DllImport("user32.dll")]
    public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);

    public static List<IntPtr> GetVisibleWindows() {
        var result = new List<IntPtr>();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
            if (IsWindowVisible(hWnd) && GetWindowTextLength(hWnd) > 0) {
                result.Add(hWnd);
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }

    public static uint GetIdleMilliseconds() {
        var info = new LASTINPUTINFO();
        info.cbSize = (uint)System.Runtime.InteropServices.Marshal.SizeOf(info);
        GetLastInputInfo(ref info);
        return (uint)Environment.TickCount - info.dwTime;
    }
}
"@

function Get-ProcTitle($hwnd) {
    $sb = New-Object System.Text.StringBuilder 512
    [Win32]::GetWindowText($hwnd, $sb, 512) | Out-Null
    $procId = 0
    [Win32]::GetWindowThreadProcessId($hwnd, [ref]$procId) | Out-Null
    $procName = "unknown"
    try {
        $proc = Get-Process -Id $procId -ErrorAction Stop
        $procName = $proc.ProcessName
    } catch {}
    return "$procName|$($sb.ToString())"
}

# 1. Ventana en foco
$hwndFocus = [Win32]::GetForegroundWindow()
Write-Output "FOCUS|$(Get-ProcTitle $hwndFocus)"

# 2. Tiempo de idle
$idleMs = [Win32]::GetIdleMilliseconds()
Write-Output "IDLE|$idleMs"

# 3. Todas las ventanas visibles
foreach ($hwnd in [Win32]::GetVisibleWindows()) {
    Write-Output "WIN|$(Get-ProcTitle $hwnd)"
}
`.trim();

class OSSensor extends BaseOSSensor {
  constructor(stateGraph) {
    super(stateGraph, { logTag: 'os-sensor' });
  }

  getOpenWindowsSummary() {
    if (!this._openWindows.length) return null;
    return this._openWindows
      .map((w) => {
        const cleanTitle = this._cleanTitle(w.app, w.title);
        return cleanTitle ? `${w.friendlyName} (${cleanTitle})` : w.friendlyName;
      })
      .join(', ');
  }

  _poll() {
    if (this._pollBusy) {
      logger.warn('OSSensor', '[os-sensor] poll anterior todavía en curso, saltando...');
      return;
    }
    this._pollBusy = true;
    this._runPS(PS_SCRIPT, (err, output) => {
      this._pollBusy = false;
      if (err || !output) return;

      const lines = output
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      if (!lines.length) return;

      let focus = null;
      let focusIgnored = false; // FIX: distinguir "no hubo línea FOCUS" de "FOCUS cayó en app ignorada"
      let idleMs = 0;
      const windows = [];

      for (const line of lines) {
        const sepIdx = line.indexOf('|');
        if (sepIdx === -1) continue;
        const kind = line.slice(0, sepIdx);
        const rest = line.slice(sepIdx + 1);

        if (kind === 'IDLE') {
          idleMs = parseInt(rest, 10) || 0;
          continue;
        }

        const partsIdx = rest.indexOf('|');
        if (partsIdx === -1) continue;
        const procName = rest.slice(0, partsIdx).trim();
        const title = rest.slice(partsIdx + 1).trim();

        if (!procName || procName === 'unknown') continue;

        // FIX tracking: para la línea FOCUS necesitamos saber si cayó en
        // una app ignorada ANTES de descartarla — eso es lo que dispara
        // la pausa del tracking de tiempo más abajo.
        if (kind === 'FOCUS') {
          if (shouldIgnoreApp(procName)) {
            focusIgnored = true;
          } else {
            focus = { procName, title };
          }
          continue;
        }

        // FIX Bug 13: usar shouldIgnoreApp en lugar del Set directamente
        if (shouldIgnoreApp(procName)) continue;

        if (kind === 'WIN') {
          windows.push({
            app: procName,
            friendlyName: this._getFriendlyName(procName),
            title,
            category: this._getCategory(procName),
          });
        }
      }

      this._processIdle(Math.round(idleMs / 1000));

      const seen = new Set();
      const dedup = [];
      for (const w of windows) {
        const key = `${w.app}::${w.title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        dedup.push(w);
      }
      this._openWindows = dedup;
      this._bus.emit('os:windows-updated', { windows: dedup });

      if (focus) {
        this._processFocus(focus.procName, focus.title);
      } else if (focusIgnored) {
        // FIX tracking: el foco se movió a una app ignorada — pausar el
        // tracking en vez de dejar que el tiempo siga corriendo
        // silenciosamente contra la app anterior.
        this._pauseTracking();
      }
    });
  }

  _saveToHistory(app, title, start, end) {
    const duration = Math.round((end - start) / 1000);
    if (duration < 5) return;
    const entry = {
      app,
      friendlyName: this._getFriendlyName(app),
      title: title?.slice(0, 120) || '',
      category: this._getCategory(app),
      start,
      end,
      duration,
    };
    this._history.push(entry);
    if (this._history.length > this._maxHistory) this._history.shift();
    if (this._graph?._ready && typeof this._graph.saveAppHistory === 'function') {
      try {
        this._graph.saveAppHistory(entry);
      } catch (e) {
        logger.warn('OSSensor', '[os-sensor] error guardando historial:', e.message);
      }
    }
    this._bus.emit('os:history-updated', {
      latest: entry,
      todayCount: this.getTodayHistory().length,
    });
  }

  _getFriendlyName(procName) {
    if (!procName) return null;
    return APP_NAMES[procName] || procName;
  }

  _getCategory(procName) {
    if (!procName) return 'other';
    const lower = procName.toLowerCase();
    for (const [cat, apps] of Object.entries(APP_CATEGORIES)) {
      if (apps.some((a) => a.toLowerCase() === lower)) return cat;
    }
    return 'other';
  }

  _formatElapsed(seconds) {
    return formatElapsed(seconds);
  }

  _cleanTitle(procName, title) {
    if (!title) return '';
    let t = title;
    if (t.match(/^[A-Z]:\\Windows\\system32\\/i)) return '';
    if (t.match(/^[A-Z]:\\/i) && t.endsWith('.exe')) return '';
    t = t.replace(/\s*[-–—]?\s*y \d+\s+p[áa]gin\w* m[áa]s/gi, '');
    t = t.replace(/\s*[-–—]?\s*and \d+\s+more\s*/gi, '');
    t = t.replace(/\s*[-–—]\s*(Microsoft\??\s*Edge|Google Chrome|Mozilla Firefox)\s*$/i, '');
    t = t.replace(/\s*[-–—]\s*Visual Studio Code\s*$/i, '');
    return t.trim();
  }

  _runPS(script, callback) {
    let output = '',
      error = '',
      done = false;
    const finish = (err, out) => {
      if (done) return;
      done = true;
      callback(err, out);
    };
    let proc;
    try {
      proc = spawn(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
        { windowsHide: true }
      );
      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');
      proc.stdout.on('data', (d) => {
        output += d;
      });
      proc.stderr.on('data', (d) => {
        error += d;
      });
      proc.on('close', (code) => {
        if (code !== 0 || error) finish(new Error(error || `exit code ${code}`), null);
        else finish(null, output.trim());
      });
      proc.on('error', (e) => finish(e, null));
    } catch (e) {
      finish(e, null);
      return;
    }
    const timeout = setTimeout(() => {
      if (done) return;
      logger.warn('OSSensor', '[os-sensor] PowerShell timeout (>8s), matando proceso');
      try {
        proc.kill();
      } catch (_) {}
      finish(new Error('powershell timeout'), null);
    }, 8000);
    proc.on('close', () => clearTimeout(timeout));
  }
}

module.exports = { OSSensor, APP_CATEGORIES, APP_NAMES };
