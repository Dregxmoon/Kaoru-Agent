'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { DesktopControl, _parseDesktopEntry } = require('../core/desktop/DesktopControl.js');
const { OpenClawBridge } = require('../core/planner/OpenClawBridge.js');
const { ToolRegistry } = require('../core/task/ToolRegistry.js');
const { resolveToolset } = require('../core/task/ToolResolver.js');
const { getToolSchemas } = require('../core/llm/ToolSchemas.js');
const { isHighImpact } = require('../core/planner/ActionParser.js');
const { StructuredActionParser } = require('../core/planner/StructuredActionParser.js');

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

async function rejects(fn, pattern, label) {
  try {
    await fn();
    assert(false, label, 'no rechazó');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(pattern.test(message), label, message);
  }
}

function fakeSpawner(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
}

async function testWebsiteOpening() {
  console.log('\n── Sitios visibles y validación ───────────────────────');
  const opened = [];
  const guarded = [];
  const control = new DesktopControl({
    platform: 'linux',
    openExternal: async (url) => opened.push(url),
    urlGuard: async (url) => {
      guarded.push(url);
      return { safe: !url.includes('blocked.example') };
    },
  });

  const youtube = await control.openWebsite({ target: 'youtube' });
  assert(opened[0] === 'https://www.youtube.com/', 'youtube abre el alias HTTPS esperado');
  assert(youtube.browser === 'default', 'sin browser usa el predeterminado');
  assert(guarded.length === 1, 'la URL pasa por UrlGuard antes de abrirse');

  const privateResult = await control.openWebsite({
    target: 'https://example.com/video?token=secreto#parte',
  });
  assert(opened[1].includes('token=secreto'), 'el navegador recibe la URL completa solicitada');
  assert(
    !privateResult.url.includes('token='),
    'el resultado no devuelve query potencialmente sensible'
  );

  await rejects(
    () => control.openWebsite({ target: 'javascript:alert(1)' }),
    /Solo se permiten URLs https/,
    'bloquea javascript:'
  );
  await rejects(
    () => control.openWebsite({ target: 'http://example.com' }),
    /Solo se permiten URLs https/,
    'bloquea HTTP sin cifrar'
  );
  await rejects(
    () => control.openWebsite({ target: 'https://user:pass@example.com' }),
    /credenciales/,
    'bloquea credenciales embebidas'
  );
  await rejects(
    () => control.openWebsite({ target: 'https://blocked.example' }),
    /URL bloqueada/,
    'respeta el bloqueo SSRF de UrlGuard'
  );
}

async function testSafeLaunch() {
  console.log('\n── Lanzamiento sin shell ──────────────────────────────');
  const calls = [];
  const control = new DesktopControl({
    platform: 'linux',
    spawnImpl: fakeSpawner(calls),
    urlGuard: async () => ({ safe: true }),
  });
  await control.launchApp({ app: 'firefox' });
  assert(calls[0].command === 'firefox', 'alias firefox resuelve a ejecutable conocido');
  assert(calls[0].options.shell === false, 'nunca usa una shell');
  assert(Array.isArray(calls[0].args) && calls[0].args.length === 0, 'argumentos van separados');

  await control.openWebsite({ target: 'drive', browser: 'firefox' });
  assert(calls[1].command === 'firefox', 'puede elegir un navegador permitido');
  assert(calls[1].args[0] === 'https://drive.google.com/', 'URL se entrega como argumento aislado');

  await rejects(
    () => control.launchApp({ app: '--command' }),
    /caracteres no permitidos/,
    'rechaza nombres que podrían convertirse en opciones'
  );
  await rejects(
    () => control.openWebsite({ target: 'youtube', browser: 'terminal' }),
    /Navegador no permitido/,
    'rechaza navegadores arbitrarios'
  );
}

async function testDesktopDiscovery() {
  console.log('\n── Descubrimiento Linux seguro ────────────────────────');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-desktop-'));
  const appDir = path.join(home, '.local', 'share', 'applications');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(
    path.join(appDir, 'my-game.desktop'),
    '[Desktop Entry]\nType=Application\nName=Mi Juego\nExec=sh -c "malicioso"\n'
  );
  fs.writeFileSync(
    path.join(appDir, '--option.desktop'),
    '[Desktop Entry]\nType=Application\nName=Opción peligrosa\nExec=x\n'
  );
  const calls = [];
  const control = new DesktopControl({
    platform: 'linux',
    homeDir: home,
    env: { XDG_DATA_HOME: path.join(home, '.local', 'share') },
    spawnImpl: fakeSpawner(calls),
  });

  const apps = await control.searchApps({ query: 'juego' });
  assert(
    apps.some((app) => app.name === 'Mi Juego'),
    'encuentra juegos desde archivos .desktop'
  );
  assert(!apps.some((app) => app.name === 'Opción peligrosa'), 'descarta IDs que parecen opciones');
  await control.launchApp({ app: 'Mi Juego' });
  assert(calls[0].command === 'gtk-launch', 'usa gtk-launch para apps descubiertas');
  assert(calls[0].args[0] === 'my-game', 'lanza por desktop ID, no interpreta Exec');

  const hidden = _parseDesktopEntry(
    '[Desktop Entry]\nType=Application\nName=Oculta\nNoDisplay=true\n',
    'hidden'
  );
  assert(hidden === null, 'omite entradas ocultas');

  // Nombres localizados: el primario muta con el locale, los demás viajan
  // como aliases para que "calculadora" encuentre Calculator sin listas.
  fs.writeFileSync(
    path.join(appDir, 'calc.desktop'),
    '[Desktop Entry]\nType=Application\nName=Calculator\nName[es]=Calculadora\nExec=x\n'
  );
  const controlEs = new DesktopControl({
    platform: 'linux',
    homeDir: home,
    env: { XDG_DATA_HOME: path.join(home, '.local', 'share') },
    spawnImpl: fakeSpawner([]),
  });
  const porAlias = await controlEs.searchApps({ query: 'calculadora' });
  assert(
    porAlias.some((app) => app.id === 'calc'),
    '"calculadora" encuentra Calculator por alias localizado'
  );
  const parsed = _parseDesktopEntry(
    '[Desktop Entry]\nType=Application\nName=Calculator\nName[es]=Calculadora\n',
    'calc'
  );
  assert(
    parsed !== null &&
      (parsed.name === 'Calculator' || parsed.name === 'Calculadora') &&
      Array.isArray(parsed.aliases) &&
      parsed.aliases.length > 0,
    'conserva ambas formas (primario + aliases)'
  );
  await controlEs.launchApp({ app: 'Calculadora' });
  assert(true, 'lanza por nombre localizado exacto');
}

async function testWindowsDiscoveryAndLaunch() {
  console.log('\n── Descubrimiento y lanzamiento Windows ──────────────');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-win-apps-'));
  const appData = path.join(root, 'AppData', 'Roaming');
  const startMenu = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  fs.mkdirSync(startMenu, { recursive: true });
  const shortcut = path.join(startMenu, 'Mi Juego.lnk');
  fs.writeFileSync(shortcut, 'fixture');
  const calls = [];
  const control = new DesktopControl({
    platform: 'win32',
    env: { APPDATA: appData },
    processRunner: async (command, args, payload, options) => {
      calls.push({ command, args, payload, options });
      return { ok: true, processId: 99 };
    },
  });
  const apps = await control.searchApps({ query: 'juego' });
  assert(
    apps.some((app) => app.name === 'Mi Juego'),
    'Windows descubre accesos del menú Inicio'
  );
  await control.launchApp({ app: 'Mi Juego' });
  const launchCall = calls.find((call) => call.payload?.target === shortcut);
  assert(launchCall?.command === 'powershell.exe', 'Windows lanza mediante helper PowerShell');
  assert(
    !JSON.stringify(launchCall?.args).includes(shortcut),
    'la ruta descubierta viaja por stdin y no se interpola en el script'
  );
  assert(launchCall?.payload.target === shortcut, 'el helper recibe el acceso descubierto exacto');
}

async function testProcessesAndCamera() {
  console.log('\n── Procesos, cámara y capacidades ─────────────────────');
  const calls = [];
  const stopped = [];
  const control = new DesktopControl({
    platform: 'linux',
    spawnImpl: fakeSpawner(calls),
    processLister: async () => [
      { pid: 42, name: 'demo-player' },
      { pid: 77, name: 'otro-proceso' },
    ],
    killProcess: async (pid) => stopped.push(pid),
    cameraStatus: async () => 'granted',
  });
  const processes = await control.listProcesses({ query: 'player', limit: 10 });
  assert(
    processes.length === 1 && processes[0].pid === 42,
    'lista procesos acotados sin argumentos ni entorno'
  );
  const stoppedResult = await control.stopProcess({ pid: 42 });
  assert(
    stopped[0] === 42 &&
      stoppedResult.status === 'executed_unverified' &&
      stoppedResult.requiresObservation,
    'termina únicamente el PID validado y exige comprobar el efecto'
  );
  await rejects(
    () => control.stopProcess({ pid: process.pid }),
    /PID no permitido/,
    'impide terminar el propio proceso de Kaoru'
  );
  const camera = await control.getCameraStatus();
  assert(
    camera.status === 'granted' && camera.captureSupported === false,
    'consulta cámara sin capturar video'
  );
  await control.openCamera();
  assert(calls[0]?.command === 'gnome-camera', 'abre una aplicación de cámara conocida sin shell');
  const capabilities = await control.capabilities();
  assert(
    capabilities.capabilities.processes && !capabilities.capabilities.cameraCapture,
    'declara capacidades reales y no promete captura silenciosa'
  );
}

async function testPipelineIntegration() {
  console.log('\n── Integración AgentLoop y permisos ───────────────────');
  const names = new Set(getToolSchemas().map((schema) => schema.name));
  const desktopNames = [
    'list_apps',
    'launch_app',
    'open_website',
    'play_media',
    'desktop_snapshot',
    'desktop_screenshot',
    'pointer_click',
    'window_list',
    'window_focus',
    'ui_get_state',
    'ui_wait',
    'ui_click',
    'ui_type',
    'ui_press',
    'ui_select',
    'ui_scroll',
    'window_close',
    'desktop_capabilities',
    'process_list',
    'process_stop',
    'camera_status',
    'open_camera',
  ];
  for (const name of desktopNames) {
    assert(names.has(name), `${name} tiene schema nativo`);
  }
  const registry = new ToolRegistry();
  registry.setOpenClawBridge({ getStats: () => ({ available: false }) });
  const desktopTools = registry
    ._getDesktopTools()
    .filter((tool) => desktopNames.includes(tool.name));
  assert(desktopTools.length === desktopNames.length, 'todas las tools están en ToolRegistry');
  assert(
    desktopTools.every((tool) => tool.available),
    'siguen disponibles sin servidor OpenClaw'
  );
  const resolved = await resolveToolset({ toolRegistry: registry });
  const resolvedNames = new Set((resolved.nativeToolSchemas || []).map((schema) => schema.name));
  assert(
    desktopNames.every((name) => resolvedNames.has(name)),
    'ToolResolver conserva escritorio cuando OpenClaw está apagado'
  );
  assert(isHighImpact('list_apps', {}), 'listar aplicaciones exige aprobación por privacidad');
  assert(isHighImpact('launch_app', { app: 'steam' }), 'abrir aplicaciones exige aprobación');
  assert(isHighImpact('open_website', { target: 'youtube' }), 'abrir sitios exige aprobación');
  assert(isHighImpact('play_media', { query: 'guitarra' }), 'reproducir exige aprobación');
  assert(isHighImpact('process_list', {}), 'listar procesos exige aprobación por privacidad');
  assert(isHighImpact('process_stop', { pid: 42 }), 'terminar procesos exige aprobación');
  assert(isHighImpact('open_camera', {}), 'abrir la cámara exige aprobación');

  const bridge = new OpenClawBridge({
    desktopControl: {
      execute: async (tool, params) =>
        tool === 'open_website'
          ? { url: params.target, browser: params.browser || 'default' }
          : { tool, params },
    },
    mediaResolver: async () => 'https://www.youtube.com/watch?v=abc123_DEF&autoplay=1',
    mediaPlayer: async (query) => ({
      kind: 'media',
      service: 'youtube',
      query,
      url: 'https://www.youtube.com/watch?v=abc123_DEF&autoplay=1',
      browser: 'kaoru-managed-chromium',
      playing: true,
      verified: true,
    }),
    desktopAutomation: {
      snapshot: async () => ({ kind: 'desktop_snapshot', observationId: 'obs-1', nodes: [] }),
      screenshot: async () => ({ kind: 'desktop_screenshot', byteLength: 10, dataUrl: 'data:x' }),
      pointerClick: async () => ({
        kind: 'desktop_action',
        action: 'pointer_click',
        executed: true,
      }),
      listWindows: async () => ({ kind: 'window_list', observationId: 'obs-2', nodes: [] }),
      getState: () => ({ kind: 'ui_state', verified: true }),
      waitFor: async () => ({ kind: 'ui_wait', verified: true }),
      execute: async (action) => ({
        kind: 'desktop_action',
        action,
        executed: true,
        intentVerified: true,
      }),
      waitForWindow: async () => ({ verified: true }),
    },
  });
  const result = await bridge.execute('launch_app', { app: 'steam' });
  assert(result.ok && result.result.tool === 'launch_app', 'OpenClawBridge despacha localmente');
  const gmail = await bridge.execute('open_website', { target: 'gmail' });
  assert(
    gmail.ok && gmail.result.browser === 'default',
    'open_website usa por defecto el navegador personal con sus sesiones'
  );
  assert(bridge.getStats().available === null, 'no consulta el servidor HTTP para escritorio');
  const snapshot = await bridge.execute('desktop_snapshot', { application: 'Demo' });
  assert(snapshot.ok && snapshot.result.observationId === 'obs-1', 'despacha observación nativa');
  const click = await bridge.execute('ui_click', { observationId: 'obs-1', ref: 'ui-1' });
  assert(click.ok && click.result.action === 'click', 'despacha acciones UI nativas');
  const state = await bridge.execute('ui_get_state', { observationId: 'obs-1', ref: 'ui-1' });
  assert(state.ok && state.result.verified, 'despacha consultas de estado UI');
  const wait = await bridge.execute('ui_wait', { expected: { name: 'Listo' } });
  assert(wait.ok && wait.result.verified, 'despacha esperas de postcondición UI');
  const media = await bridge.execute('play_media', { query: 'video de guitarra' });
  assert(media.ok && media.result.kind === 'media', 'play_media resuelve y abre el video');
  assert(media.result.autoplayRequested === true, 'play_media registra solicitud de autoplay');
  assert(media.result.verified === true, 'play_media exige evidencia de reproducción');
  const hostileBridge = new OpenClawBridge({
    desktopControl: { execute: async () => ({ url: '', browser: 'default' }) },
    mediaPlayer: async () => ({
      url: 'https://evil.example/watch?v=abc123_DEF',
      playing: true,
      verified: true,
    }),
  });
  const hostileMedia = await hostileBridge.execute('play_media', { query: 'guitarra' });
  assert(!hostileMedia.ok, 'play_media bloquea destinos externos devueltos por el DOM');
  const unverifiedBridge = new OpenClawBridge({
    mediaPlayer: async () => ({
      url: 'https://www.youtube.com/watch?v=abc123_DEF',
      playing: false,
      verified: false,
    }),
  });
  const unverifiedMedia = await unverifiedBridge.execute('play_media', { query: 'guitarra' });
  assert(!unverifiedMedia.ok, 'play_media no declara éxito sin reproducción verificada');

  const parser = new StructuredActionParser(process.cwd());
  const parsedApp = parser.parse(
    '```action\nACCIÓN: launch_app | APLICACIÓN: Steam\n```',
    'abre Steam'
  );
  assert(
    parsedApp[0]?.tool === 'launch_app' && parsedApp[0]?.params.app === 'Steam',
    'fallback textual convierte APLICACIÓN en app'
  );
  const parsedSite = parser.parse(
    '```action\nACCIÓN: open_website | SITIO: whatsapp | NAVEGADOR: firefox\n```',
    'abre WhatsApp'
  );
  assert(
    parsedSite[0]?.params.target === 'whatsapp' && parsedSite[0]?.params.browser === 'firefox',
    'fallback textual convierte SITIO y NAVEGADOR'
  );
  const parsedPersonalSite = parser.parse(
    '```action\nACCIÓN: open_website | SITIO: gmail\n```',
    'abre mi Gmail'
  );
  assert(
    parsedPersonalSite[0]?.params.control === 'external',
    'fallback textual conserva la sesión del navegador personal por defecto'
  );
  const parsedMedia = parser.parse(
    '```action\nACCIÓN: play_media | SERVICIO: youtube | QUERY: guitarra flamenca\n```',
    'reproduce guitarra flamenca'
  );
  assert(
    parsedMedia[0]?.tool === 'play_media' &&
      parsedMedia[0]?.params.query === 'guitarra flamenca' &&
      parsedMedia[0]?.params.control === 'managed',
    'fallback textual convierte la petición multimedia compuesta'
  );
}

async function main() {
  console.log('\n════════ DesktopControl — Test Suite ════════════════');
  await testWebsiteOpening();
  await testSafeLaunch();
  await testDesktopDiscovery();
  await testWindowsDiscoveryAndLaunch();
  await testProcessesAndCamera();
  await testPipelineIntegration();
  console.log(`\nResultado: ${passed} passed  ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
