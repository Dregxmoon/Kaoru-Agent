'use strict';

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
  }
}

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf-8');
}

(() => {
  console.log('\nFlujo unificado + presencia Live2D');
  const html = read('src/chat.html');
  const core = read('src/chat/core.js');
  const input = read('src/chat/input.js');
  const processSource = read('src/chat/process.js');
  const css = read('src/chat.css');
  const live2d = read('src/chat/live2d.js');
  const permissions = read('src/chat/permissions.js');

  assert(/id="agent-mode-badge"[\s\S]{0,220}>AUTO</.test(html), 'el badge comunica modo AUTO');
  assert(/const _agentMode = 'agent'/.test(core), 'la UI conserva un único pipeline AgentLoop');
  assert(
    /function toggleAgentMode\(\)\s*{\s*return _agentMode;/.test(core),
    'el toggle legacy ya no cambia de pipeline'
  );
  assert(!/toggleAgentMode\(\);/.test(input), 'Tab no alterna entre chat y agente');
  assert(
    !/openclawAvailable\s*&&\s*getAgentMode\(\)/.test(processSource),
    'la disponibilidad de tools no expulsa la conversación del AgentLoop'
  );
  assert(
    /#model-panel\s*\{[\s\S]*?overflow:\s*hidden/.test(css),
    'el panel Live2D queda contenido cuando está en reposo'
  );
  assert(
    /#model-panel\.avatar-overflow-active\s*\{\s*overflow:\s*visible/.test(css),
    'el panel permite desborde únicamente durante una animación'
  );
  assert(
    /#model-canvas-container\s*\{[^}]*left:\s*0;[^}]*transition:\s*none;/.test(css) &&
      /avatar-protruding/.test(live2d),
    'el modelo mantiene su posición mientras cambia la presencia'
  );
  assert(/avatar-working-out/.test(css), 'existe animación de trabajo fuera del marco');
  assert(/function animateAvatarPresence/.test(live2d), 'Live2D expone estados de presencia');
  assert(
    !/startAutonomousView|const dur = 700/.test(live2d),
    'Live2D no interpola ni cambia de encuadre autónomamente'
  );
  assert(
    /\['processes', 'Procesos'\]/.test(permissions) &&
      /\['camera', 'Cámara'\]/.test(permissions) &&
      /`capability:\$\{button\.dataset\.capability\}`/.test(permissions),
    'permisos expone interruptores de procesos y cámara'
  );
  assert(/id="desktop-capabilities"/.test(html), 'el panel contiene capacidades de escritorio');

  console.log(`\nResultado: ${passed} passed / ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
