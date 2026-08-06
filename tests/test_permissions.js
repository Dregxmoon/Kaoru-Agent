'use strict';

// Test suite: PermissionManager (allow/ask/deny) e integración en AgentLoop.

const path = require('path');
const fs = require('fs');
const os = require('os');

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  ${C.green('✓')} ${label}`);
    passed++;
  } else {
    console.log(`  ${C.red('✗')} ${label}`);
    if (detail) console.log(`    ${C.dim(detail)}`);
    failed++;
  }
}

async function main() {
  console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
  console.log(C.bold(C.cyan('  Test Suite: permisos granulares allow/ask/deny')));
  console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perms-'));

  // ── 1. resolución por especificidad ──────────────────────────────────────
  {
    const { PermissionManager } = require('../core/security/PermissionManager.js');
    const pm = new PermissionManager();

    assert(pm.list().length === 0, 'arranca sin reglas');
    assert(
      pm.check({ tool: 'exec', path: '/x', defaultAction: 'ask' }).action === 'ask',
      'sin reglas usa el default'
    );

    pm.setRule({ tool: 'exec', path: '', action: 'deny' });
    assert(
      pm.check({ tool: 'exec', path: '/cualquiera' }).action === 'deny',
      'regla global de tool se aplica a cualquier path'
    );

    pm.setRule({ tool: 'exec', path: '/home/user/proyecto', action: 'allow' });
    const inside = pm.check({ tool: 'exec', path: '/home/user/proyecto/src/index.js' });
    assert(
      inside.action === 'allow',
      'regla tool+path más específica gana sobre la global',
      JSON.stringify(inside.rule)
    );

    const outside = pm.check({ tool: 'exec', path: '/otro/lugar' });
    assert(
      outside.action === 'deny' && outside.rule.tool === 'exec',
      'fuera del path específico vuelve a la regla global (deny)',
      JSON.stringify(outside.rule)
    );

    pm.setRule({ tool: '*', path: '', action: 'allow' });
    assert(
      pm.check({ tool: 'read', path: '/x' }).action === 'allow',
      'wildcard de tool aplica a herramientas sin regla propia'
    );

    // especificidad: tool exacta > wildcard para el mismo path
    pm.setRule({ tool: 'write', path: '', action: 'deny' });
    const exact = pm.check({ tool: 'write', path: '/x' });
    assert(
      exact.action === 'deny' && exact.rule.tool === 'write',
      'tool exacta tiene prioridad sobre wildcard',
      JSON.stringify(exact.rule)
    );
  }

  // ── 2. persistencia a archivo + reload ───────────────────────────────────
  {
    const { PermissionManager } = require('../core/security/PermissionManager.js');
    const filePath = path.join(tmp, 'permissions.json');
    const pm = new PermissionManager({ filePath });
    pm.setRule({ tool: 'git_commit', path: '', action: 'ask' });
    pm.setRule({ tool: 'write', path: '/solo/aqui', action: 'allow' });

    const pm2 = new PermissionManager({ filePath });
    assert(pm2.list().length === 2, 'las reglas persisten y se recargan');
    assert(
      pm2.check({ tool: 'git_commit', path: '/repo' }).action === 'ask',
      'regla recargada resuelve igual'
    );

    const removed = pm2.removeRule({ tool: 'write', path: '/solo/aqui' });
    assert(removed, 'removeRule elimina la regla');
    assert(pm2.list().length === 1, 'queda 1 regla tras eliminar');

    // action inválida lanza
    let threw = false;
    try {
      pm2.setRule({ tool: 'x', action: 'siempre' });
    } catch {
      threw = true;
    }
    assert(threw, 'setRule rechaza acciones inválidas');
  }

  // ── 3. archivo corrupto → arranca vacío ──────────────────────────────────
  {
    const { PermissionManager } = require('../core/security/PermissionManager.js');
    const filePath = path.join(tmp, 'bad-permissions.json');
    fs.writeFileSync(filePath, '{roto', 'utf-8');
    const pm = new PermissionManager({ filePath });
    assert(pm.list().length === 0, 'JSON corrupto no rompe el manager');
  }

  // ── 4. integración AgentLoop: allow / ask / deny ─────────────────────────
  {
    const { AgentLoop } = require('../core/planner/AgentLoop.js');
    const LLMProvider = require('../core/llm/LLMProvider.js');
    const { PermissionManager } = require('../core/security/PermissionManager.js');

    // 4a. allow: write (alto impacto) se ejecuta sin aprobación
    {
      const executed = [];
      const mockBridge = {
        execute: async (tool) => {
          executed.push(tool);
          return { ok: true, result: 'escrito', error: null, tool, elapsed: 0 };
        },
      };
      const pm = new PermissionManager();
      pm.setRule({ tool: 'write', path: '', action: 'allow' });

      const original = LLMProvider.completeWithTools;
      let calls = 0;
      LLMProvider.completeWithTools = async () => {
        calls++;
        if (calls === 1)
          return {
            content: null,
            toolCalls: [{ tool: 'write', params: { path: '/tmp/a', content: 'x' } }],
          };
        return { content: 'listo', toolCalls: null };
      };
      try {
        let approvalCalls = 0;
        const loop = new AgentLoop({ maxIterations: 5, llm: async () => 'x', bridge: mockBridge });
        const result = await loop.run('escribe', 'Eres un asistente.', [], {
          tools: [
            {
              name: 'write',
              description: 'escribe',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
          permissionManager: pm,
          onApprovalNeeded: async () => {
            approvalCalls++;
            return true;
          },
        });
        assert(executed.includes('write'), 'write se ejecuta con permiso allow');
        assert(
          approvalCalls === 0,
          'allow no llama a onApprovalNeeded',
          `aprobaciones: ${approvalCalls}`
        );
        assert(!result.error, 'sin error', result.error || '');
      } finally {
        LLMProvider.completeWithTools = original;
      }
    }

    // 4b. deny: write bloqueado sin ejecutarse
    {
      const executed = [];
      const mockBridge = {
        execute: async (tool) => {
          executed.push(tool);
          return { ok: true, result: 'escrito', error: null, tool, elapsed: 0 };
        },
      };
      const pm = new PermissionManager();
      pm.setRule({ tool: 'write', path: '', action: 'deny' });

      const original = LLMProvider.completeWithTools;
      let calls = 0;
      LLMProvider.completeWithTools = async () => {
        calls++;
        if (calls === 1)
          return {
            content: null,
            toolCalls: [{ tool: 'write', params: { path: '/tmp/a', content: 'x' } }],
          };
        return { content: 'ok, sin escribir', toolCalls: null };
      };
      try {
        const loop = new AgentLoop({ maxIterations: 5, llm: async () => 'x', bridge: mockBridge });
        const result = await loop.run('escribe', 'Eres un asistente.', [], {
          tools: [
            {
              name: 'write',
              description: 'escribe',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
          permissionManager: pm,
          onApprovalNeeded: async () => true,
        });
        assert(executed.length === 0, 'deny impide la ejecución de write');
        assert(!result.error, 'deny no rompe el loop', result.error || '');
      } finally {
        LLMProvider.completeWithTools = original;
      }
    }

    // 4c. ask (default): write de alto impacto pide aprobación
    {
      const executed = [];
      const mockBridge = {
        execute: async (tool) => {
          executed.push(tool);
          return { ok: true, result: 'escrito', error: null, tool, elapsed: 0 };
        },
      };
      const pm = new PermissionManager();

      const original = LLMProvider.completeWithTools;
      let calls = 0;
      LLMProvider.completeWithTools = async () => {
        calls++;
        if (calls === 1)
          return {
            content: null,
            toolCalls: [{ tool: 'write', params: { path: '/tmp/a', content: 'x' } }],
          };
        return { content: 'listo', toolCalls: null };
      };
      try {
        let approvalCalls = 0;
        const loop = new AgentLoop({ maxIterations: 5, llm: async () => 'x', bridge: mockBridge });
        await loop.run('escribe', 'Eres un asistente.', [], {
          tools: [
            {
              name: 'write',
              description: 'escribe',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
          permissionManager: pm,
          onApprovalNeeded: async () => {
            approvalCalls++;
            return true;
          },
        });
        assert(executed.includes('write'), 'con aprobación sí se ejecuta');
        assert(
          approvalCalls === 1,
          'ask de alto impacto pide aprobación una vez',
          `aprobaciones: ${approvalCalls}`
        );
      } finally {
        LLMProvider.completeWithTools = original;
      }
    }
  }

  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(C.bold('\n════════════════════════════════════════════════════════'));
  const total = passed + failed;
  if (failed === 0) {
    console.log(
      `  ${C.green('Resultado')}: ${C.green(`${passed} passed`)}  ${C.dim('0 failed')}  / ${total} total`
    );
  } else {
    console.log(
      `  Resultado: ${C.green(`${passed} passed`)}  ${C.red(`${failed} failed`)}  / ${total} total`
    );
  }
  console.log(C.bold('════════════════════════════════════════════════════════'));

  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
