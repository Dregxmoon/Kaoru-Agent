/**
 * OSSensor.js — Fase 2 (mejorado)
 *
 * Detecta:
 *  - Qué app/ventana tiene el foco y cuánto tiempo lleva ahí.
 *  - TODAS las ventanas visibles abiertas (no solo la activa).
 *  - Historial de apps usadas durante el día.
 *  - Tiempo de idle del usuario (sin tocar teclado/mouse).
 *
 * Mejoras respecto a la versión anterior:
 *   - Flag _pollBusy: evita procesos PowerShell zombie si un poll tarda más de 5s
 *   - saveAppHistory: ahora existe en el StateGraph y se llama correctamente
 *   - Idle detection: GetLastInputInfo via PowerShell (sin dependencias nativas)
 *   - idleSecs e idleFormatted expuestos en getCurrentContext()
 *   - PS_SCRIPT como constante del módulo (no se reconstruye en cada poll)
 *   - Mejor manejo de errores en _runPS con timeout de 8s
 *
 * Emite al EventBus:
 *   os:app-changed     — cuando cambia la app activa
 *   os:app-tick        — cada poll si la app no cambió
 *   os:windows-updated — cada poll con la lista de ventanas abiertas
 *   os:history-updated — cuando se guarda una entrada en historial
 *   os:idle-changed    — cuando el usuario pasa de activo a idle o viceversa
 */

const { spawn }       = require('child_process');
const { getEventBus } = require('../event-bus/EventBus.js');

// Apps ignoradas (sistema, overlay propio, etc.)
const IGNORED_APPS = new Set([
  'explorer', 'SearchHost', 'ShellExperienceHost', 'StartMenuExperienceHost',
  'LockApp', 'LogonUI', 'dwm', 'taskhostw', 'RuntimeBroker',
  'TextInputHost', 'ApplicationFrameHost', 'SystemSettings',
  'vtuber-overlay', 'electron',
  'RazerAppEngine', 'RazerCentralService', 'RazerIngameEngine',
  'rzsd', 'Razer Synapse', 'RzSDKService',
]);

const APP_NAMES = {
  'Code':            'Visual Studio Code',
  'code':            'Visual Studio Code',
  'cursor':          'Cursor',
  'chrome':          'Google Chrome',
  'msedge':          'Microsoft Edge',
  'firefox':         'Firefox',
  'Discord':         'Discord',
  'discord':         'Discord',
  'Slack':           'Slack',
  'slack':           'Slack',
  'WINWORD':         'Microsoft Word',
  'EXCEL':           'Microsoft Excel',
  'POWERPNT':        'PowerPoint',
  'notion':          'Notion',
  'obsidian':        'Obsidian',
  'figma':           'Figma',
  'Figma':           'Figma',
  'spotify':         'Spotify',
  'Spotify':         'Spotify',
  'WhatsApp':        'WhatsApp',
  'Telegram':        'Telegram',
  'WindowsTerminal': 'Terminal',
  'cmd':             'Símbolo del sistema',
  'powershell':      'PowerShell',
  'wt':              'Terminal',
  'notepad':         'Bloc de notas',
  'notepad++':       'Notepad++',
  'sublime_text':    'Sublime Text',
  'idea64':          'IntelliJ IDEA',
  'pycharm64':       'PyCharm',
  'webstorm64':      'WebStorm',
  'postman':         'Postman',
  'insomnia':        'Insomnia',
  'vlc':             'VLC',
  'warp': 'Warp Terminal',
  'mpc-hc64':        'Media Player Classic',
  'explorer':        'Explorador de archivos',
  'SystemSettings':  'Configuración de Windows',
};

const APP_CATEGORIES = {
  code:     ['Code', 'code', 'cursor', 'idea64', 'pycharm64', 'webstorm64', 'sublime_text', 'notepad++'],
  terminal: ['WindowsTerminal', 'cmd', 'powershell', 'wt', 'warp'],
  browser:  ['chrome', 'msedge', 'firefox'],
  design:   ['figma', 'Figma'],
  docs:     ['WINWORD', 'EXCEL', 'POWERPNT', 'notion', 'obsidian', 'notepad'],
  chat:     ['Discord', 'discord', 'Slack', 'slack', 'WhatsApp', 'Telegram'],
  media:    ['spotify', 'Spotify', 'vlc', 'mpc-hc64'],
  api:      ['postman', 'insomnia'],
  files:    ['explorer'],
  system:   ['SystemSettings', 'ApplicationFrameHost'],
};

// Umbral de idle en segundos para considerar al usuario "ausente"
const IDLE_THRESHOLD_SECS = 120; // 2 minutos

/**
 * Script PowerShell unificado:
 *   Línea 1:  FOCUS|<procName>|<title>
 *   Línea 2:  IDLE|<milisegundos desde último input>
 *   Resto:    WIN|<procName>|<title>
 */
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

class OSSensor {
  constructor(stateGraph) {
    this._graph        = stateGraph;
    this._bus          = getEventBus();
    this._polling      = null;
    this._pollBusy     = false;   // FIX: evita procesos zombie
    this._pollMs       = 5000;
    this._currentApp   = null;
    this._currentTitle = null;
    this._appStart     = null;
    this._openWindows  = [];
    this._history      = [];
    this._maxHistory   = 100;
    this._running      = false;
    // Idle
    this._idleSecs     = 0;
    this._wasIdle      = false;
  }

  start() {
    if (this._running) return;
    this._running = true;
    console.log('[os-sensor] iniciado (poll cada 5s)');
    this._poll();
    this._polling = setInterval(() => this._poll(), this._pollMs);
  }

  stop() {
    if (this._polling) { clearInterval(this._polling); this._polling = null; }
    this._running = false;
    console.log('[os-sensor] detenido');
  }

  getCurrentContext() {
    const elapsed = this._appStart
      ? Math.round((Date.now() - this._appStart) / 1000)
      : 0;

    return {
      app:                this._currentApp,
      friendlyName:       this._getFriendlyName(this._currentApp),
      title:              this._currentTitle,
      category:           this._getCategory(this._currentApp),
      elapsed,
      elapsedFormatted:   this._formatElapsed(elapsed),
      idleSecs:           this._idleSecs,
      idleFormatted:      this._idleSecs > 0 ? this._formatElapsed(this._idleSecs) : null,
      isIdle:             this._idleSecs >= IDLE_THRESHOLD_SECS,
      openWindows:        this.getOpenWindows(),
      openWindowsSummary: this.getOpenWindowsSummary(),
      history:            this.getTodayHistory(),
    };
  }

  getOpenWindows() {
    return this._openWindows.map(w => ({
      ...w,
      focused: w.app === this._currentApp && w.title === this._currentTitle,
    }));
  }

  getOpenWindowsSummary() {
    if (!this._openWindows.length) return null;
    return this._openWindows.map(w => {
      const cleanTitle = this._cleanTitle(w.app, w.title);
      return cleanTitle ? `${w.friendlyName} (${cleanTitle})` : w.friendlyName;
    }).join(', ');
  }

  getTodayHistory() {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    return this._history.filter(e => e.start >= startOfDay.getTime());
  }

  getTodaySummary() {
    const today = this.getTodayHistory();
    if (!today.length) return null;

    const byApp = {};
    for (const entry of today) {
      const key = entry.friendlyName || entry.app;
      byApp[key] = (byApp[key] || 0) + (entry.duration || 0);
    }

    return Object.entries(byApp)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 8)
      .map(([app, secs]) => `${app} (${this._formatElapsed(secs)})`)
      .join(', ');
  }

  // ── Polling ────────────────────────────────────────────────────────────────

  _poll() {
    // FIX: si el poll anterior no terminó, saltar este ciclo
    if (this._pollBusy) {
      console.warn('[os-sensor] poll anterior todavía en curso, saltando...');
      return;
    }

    this._pollBusy = true;

    this._runPS(PS_SCRIPT, (err, output) => {
      this._pollBusy = false;

      if (err || !output) return;

      const lines = output.split('\n').map(l => l.trim()).filter(Boolean);
      if (!lines.length) return;

      let focus    = null;
      let idleMs   = 0;
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
        const title    = rest.slice(partsIdx + 1).trim();

        if (!procName || procName === 'unknown') continue;
        if ([...IGNORED_APPS].some(ig => procName.toLowerCase().includes(ig.toLowerCase()))) continue;

        if (kind === 'FOCUS') {
          focus = { procName, title };
        } else if (kind === 'WIN') {
          windows.push({
            app:          procName,
            friendlyName: this._getFriendlyName(procName),
            title,
            category:     this._getCategory(procName),
          });
        }
      }

      // Procesar idle
      this._processIdle(Math.round(idleMs / 1000));

      // Deduplicar ventanas
      const seen  = new Set();
      const dedup = [];
      for (const w of windows) {
        const key = `${w.app}::${w.title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        dedup.push(w);
      }
      this._openWindows = dedup;
      this._bus.emit('os:windows-updated', { windows: dedup });

      if (focus) this._processFocus(focus.procName, focus.title);
    });
  }

  _processIdle(idleSecs) {
    this._idleSecs = idleSecs;
    const isIdle   = idleSecs >= IDLE_THRESHOLD_SECS;

    if (isIdle && !this._wasIdle) {
      this._wasIdle = true;
      this._bus.emit('os:idle-changed', { idle: true, idleSecs });
      console.log(`[os-sensor] usuario idle (${this._formatElapsed(idleSecs)})`);
    } else if (!isIdle && this._wasIdle) {
      this._wasIdle = false;
      this._bus.emit('os:idle-changed', { idle: false, idleSecs: 0 });
      console.log('[os-sensor] usuario activo de nuevo');
    }
  }

  _processFocus(procName, title) {
    const elapsed = this._appStart
      ? Math.round((Date.now() - this._appStart) / 1000)
      : 0;

    if (procName !== this._currentApp) {
      if (this._currentApp && this._appStart) {
        this._saveToHistory(this._currentApp, this._currentTitle, this._appStart, Date.now());
      }

      const prev         = this._currentApp;
      this._currentApp   = procName;
      this._currentTitle = title;
      this._appStart     = Date.now();

      this._bus.emit('os:app-changed', {
        app:          procName,
        friendlyName: this._getFriendlyName(procName),
        title,
        category:     this._getCategory(procName),
        elapsed:      0,
        prev,
        prevFriendly: this._getFriendlyName(prev),
      });

      console.log(`[os-sensor] → ${this._getFriendlyName(procName)} — "${title.slice(0, 60)}"`);
    } else {
      this._currentTitle = title;
      this._bus.emit('os:app-tick', {
        app:              procName,
        friendlyName:     this._getFriendlyName(procName),
        title,
        category:         this._getCategory(procName),
        elapsed,
        elapsedFormatted: this._formatElapsed(elapsed),
      });
    }
  }

  _saveToHistory(app, title, start, end) {
    const duration = Math.round((end - start) / 1000);
    if (duration < 5) return;

    const entry = {
      app,
      friendlyName: this._getFriendlyName(app),
      title:        title?.slice(0, 120) || '',
      category:     this._getCategory(app),
      start,
      end,
      duration,
    };

    this._history.push(entry);
    if (this._history.length > this._maxHistory) this._history.shift();

    // FIX: saveAppHistory ahora existe en StateGraph (ver StateGraph.js)
    if (this._graph?._ready && typeof this._graph.saveAppHistory === 'function') {
      try {
        this._graph.saveAppHistory(entry);
      } catch(e) {
        console.warn('[os-sensor] error guardando historial en grafo:', e.message);
      }
    }

    this._bus.emit('os:history-updated', {
      latest:     entry,
      todayCount: this.getTodayHistory().length,
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  _getFriendlyName(procName) {
    if (!procName) return null;
    return APP_NAMES[procName] || procName;
  }

  _getCategory(procName) {
    if (!procName) return 'other';
    const lower = procName.toLowerCase();
    for (const [cat, apps] of Object.entries(APP_CATEGORIES)) {
      if (apps.some(a => a.toLowerCase() === lower)) return cat;
    }
    return 'other';
  }

  _formatElapsed(seconds) {
    if (!seconds || seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`;
  }

  _cleanTitle(procName, title) {
  if (!title) return '';
  let t = title;
  // Limpiar rutas de sistema que aparecen como título en terminales
  if (t.match(/^[A-Z]:\\Windows\\system32\\/i)) return '';
  if (t.match(/^[A-Z]:\\/i) && t.endsWith('.exe')) return '';
  // Limpiar ruido de browsers
  t = t.replace(/\s*[-–—]?\s*y \d+\s+p[áa]gin\w* m[áa]s/gi, '');
  t = t.replace(/\s*[-–—]?\s*and \d+\s+more\s*/gi, '');
  t = t.replace(/\s*[-–—]\s*(Microsoft\??\s*Edge|Google Chrome|Mozilla Firefox)\s*$/i, '');
  t = t.replace(/\s*[-–—]\s*Visual Studio Code\s*$/i, '');
  return t.trim();
}

  /**
   * Ejecuta el script PowerShell con timeout de 8s.
   * Si tarda más, mata el proceso y reporta error.
   */
  _runPS(script, callback) {
    let output  = '';
    let error   = '';
    let done    = false;

    const finish = (err, out) => {
      if (done) return;
      done = true;
      callback(err, out);
    };

    let proc;
    try {
      proc = spawn('powershell', [
        '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
        '-Command', script,
      ], { windowsHide: true });

      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');

      proc.stdout.on('data', d => { output += d; });
      proc.stderr.on('data', d => { error  += d; });

      proc.on('close', (code) => {
        if (code !== 0 || error) {
          finish(new Error(error || `exit code ${code}`), null);
        } else {
          finish(null, output.trim());
        }
      });

      proc.on('error', (e) => finish(e, null));

    } catch(e) {
      finish(e, null);
      return;
    }

    // Timeout de seguridad: si PowerShell tarda más de 8s, matar
    const timeout = setTimeout(() => {
      if (done) return;
      console.warn('[os-sensor] PowerShell timeout (>8s), matando proceso');
      try { proc.kill(); } catch(_) {}
      finish(new Error('powershell timeout'), null);
    }, 8000);

    // Limpiar timeout cuando termina normalmente
    proc.on('close', () => clearTimeout(timeout));
  }
}

module.exports = { OSSensor, APP_CATEGORIES, APP_NAMES };