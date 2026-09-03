// @ts-check
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

let passed = 0;
let failed = 0;

/** @param {unknown} condition @param {string} label @param {string} [detail] */
function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
    passed++;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

async function main() {
  console.log('\nPrivacidad de memoria — frontera IPC');
  const handlers = new Map();
  const listeners = new Map();
  let confirmationResponse = 0;
  let exportPath = '';
  const electronMock = {
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler),
      on: (channel, handler) => listeners.set(channel, handler),
    },
    dialog: {
      showMessageBox: async () => ({ response: confirmationResponse }),
      showSaveDialog: async () => ({ canceled: !exportPath, filePath: exportPath || undefined }),
    },
  };
  const originalLoad = Module._load;
  Module._load = function mockLoad(request, parent, isMain) {
    if (request === 'electron') return electronMock;
    return originalLoad.call(this, request, parent, isMain);
  };
  let register;
  try {
    ({ register } = require('../ipc/memory-handlers.js'));
  } finally {
    Module._load = originalLoad;
  }

  const trustedWebContents = {};
  const calls = { inspect: 0, correct: 0, delete: 0, export: 0 };
  const Core = {
    inspectMemory: (nodeId) => {
      calls.inspect++;
      return { ok: true, node: { id: nodeId } };
    },
    correctMemory: (payload) => {
      calls.correct++;
      return { ok: true, payload };
    },
    deleteMemoryLineage: (payload) => {
      calls.delete++;
      return { ok: true, payload };
    },
    exportMemorySnapshot: () => {
      calls.export++;
      return { schemaVersion: 1, exportedAt: 123, nodes: [] };
    },
  };
  register({
    Core,
    S: { chatWindow: { webContents: trustedWebContents, isDestroyed: () => false } },
  });

  for (const channel of ['memory-inspect', 'memory-correct', 'memory-delete', 'memory-export']) {
    assert(handlers.has(channel), `registra el canal protegido ${channel}`);
  }

  const inspect = handlers.get('memory-inspect');
  const denied = await inspect({ sender: {} }, { nodeId: 7 });
  assert(
    denied.error === 'untrusted_sender' && calls.inspect === 0,
    'rechaza un sender ajeno al chat'
  );
  const allowed = await inspect({ sender: trustedWebContents }, { nodeId: 7 });
  assert(allowed.ok && calls.inspect === 1, 'acepta la ventana de chat registrada');

  const correct = handlers.get('memory-correct');
  confirmationResponse = 0;
  const cancelledCorrection = await correct(
    { sender: trustedWebContents },
    { nodeId: 7, content: 'Contenido corregido', expectedUpdatedAt: 100 }
  );
  assert(
    cancelledCorrection.cancelled && calls.correct === 0,
    'una corrección cancelada no toca Core'
  );
  confirmationResponse = 1;
  const acceptedCorrection = await correct(
    { sender: trustedWebContents },
    { nodeId: 7, content: 'Contenido corregido', expectedUpdatedAt: 100 }
  );
  assert(
    acceptedCorrection.ok && calls.correct === 1,
    'la confirmación nativa habilita la corrección'
  );
  assert(
    acceptedCorrection.payload.expectedUpdatedAt === 100,
    'conserva el control de concurrencia hasta Core'
  );

  const remove = handlers.get('memory-delete');
  confirmationResponse = 1;
  const acceptedDeletion = await remove(
    { sender: trustedWebContents },
    { nodeId: 7, expectedUpdatedAt: 100 }
  );
  assert(
    acceptedDeletion.ok && calls.delete === 1,
    'el borrado exige y respeta confirmación nativa'
  );

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-memory-export-'));
  try {
    exportPath = path.join(dir, 'memoria.json');
    const exported = await handlers.get('memory-export')({ sender: trustedWebContents });
    const mode = fs.statSync(exportPath).mode & 0o777;
    assert(exported.ok && calls.export === 1, 'exporta sólo después de elegir destino nativo');
    assert(mode === 0o600, 'crea la exportación con permisos exclusivos del propietario');
    assert(
      JSON.parse(fs.readFileSync(exportPath, 'utf8')).schemaVersion === 1,
      'escribe JSON válido'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\nResultado: ${passed} passed  ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
