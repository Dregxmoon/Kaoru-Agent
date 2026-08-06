'use strict';

// Test suite: hooks vivos del sistema de plugins.
//
// Verifica el contrato de `runHook` del PluginManager (beforeAgentRun devolviendo
// { userMessage | systemPrompt | block }) y la integración real del hook
// `beforeTool` dentro del AgentLoop (denegación de una herramienta sin que se
// ejecute en el bridge).

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
  console.log(C.bold(C.cyan('  Test Suite: hooks vivos de plugins')));
  console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-hooks-'));

  // ── 1. runHook propaga las formas de retorno del contrato ─────────────────
  {
    const { PluginManager } = require('../core/plugins/PluginManager.js');
    const root = path.join(tmp, 'root1');
    const dir = path.join(root, 'p1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'index.js'),
      `module.exports = {
  register(ctx) {
    ctx.registerHook('beforeAgentRun', async ({ userMessage }) => {
      if (userMessage.includes('modifica')) return { userMessage: 'mensaje reescrito por plugin' };
      if (userMessage.includes('nota')) return { systemPrompt: 'NOTA DE PLUGIN: sé amable' };
      if (userMessage.includes('bloquea')) return { block: 'Ejecución bloqueada por plugin' };
      return undefined;
    });
  },
};`
    );
    const mgr = new PluginManager({ pluginDir: root, logger: () => {} });
    mgr.bind({ registry: null, dispatch: null });
    assert((await mgr.load()) === 1, 'hook: se carga el plugin de prueba');
    mgr.registerAll({});

    const out1 = await mgr.runHook('beforeAgentRun', { userMessage: 'modifica esto' });
    assert(
      out1 && out1.userMessage === 'mensaje reescrito por plugin',
      'beforeAgentRun devuelve userMessage reescrito',
      JSON.stringify(out1)
    );

    const out2 = await mgr.runHook('beforeAgentRun', { userMessage: 'añade nota' });
    assert(
      out2 && out2.systemPrompt === 'NOTA DE PLUGIN: sé amable',
      'beforeAgentRun devuelve systemPrompt anexable',
      JSON.stringify(out2)
    );

    const out3 = await mgr.runHook('beforeAgentRun', { userMessage: 'bloquea esto' });
    assert(
      out3 && out3.block === 'Ejecución bloqueada por plugin',
      'beforeAgentRun devuelve block',
      JSON.stringify(out3)
    );

    const out4 = await mgr.runHook('beforeAgentRun', { userMessage: 'normal' });
    assert(out4 === undefined, 'sin coincidencia el hook devuelve undefined');

    // Multiple hooks: el último valor no-undefined gana
    const root2 = path.join(tmp, 'root2');
    const dir2 = path.join(root2, 'p2');
    fs.mkdirSync(dir2, { recursive: true });
    fs.writeFileSync(
      path.join(dir2, 'index.js'),
      `module.exports = {
  register(ctx) {
    ctx.registerHook('beforeAgentRun', async () => ({ systemPrompt: 'uno' }));
    ctx.registerHook('beforeAgentRun', async () => ({ systemPrompt: 'dos' }));
  },
};`
    );
    const mgr2 = new PluginManager({ pluginDir: root2, logger: () => {} });
    await mgr2.load();
    mgr2.registerAll({});
    const multi = await mgr2.runHook('beforeAgentRun', {});
    assert(
      multi && multi.systemPrompt === 'dos',
      'varios hooks: gana el último valor no-undefined',
      JSON.stringify(multi)
    );
  }

  // ── 2. beforeTool deny dentro del AgentLoop ──────────────────────────────
  {
    const { AgentLoop } = require('../core/planner/AgentLoop.js');
    const LLMProvider = require('../core/llm/LLMProvider.js');

    const executed = [];
    const mockBridge = {
      execute: async (tool, params) => {
        executed.push({ tool, params });
        return {
          ok: true,
          result: `[mock] ${tool} ejecutado`,
          error: null,
          tool,
          elapsed: 0,
        };
      },
    };

    const pluginManager = {
      runHook: async (name, payload) => {
        if (name === 'beforeTool' && payload.tool === 'exec') {
          return { deny: true, reason: 'política de prueba' };
        }
        return undefined;
      },
    };

    const original = LLMProvider.completeWithTools;
    let calls = 0;
    LLMProvider.completeWithTools = async () => {
      calls++;
      if (calls === 1) {
        return {
          content: null,
          toolCalls: [{ tool: 'exec', params: { command: 'echo hola' } }],
        };
      }
      return { content: 'No pude ejecutarlo, cambio de plan.', toolCalls: null };
    };

    try {
      const loop = new AgentLoop({ maxIterations: 5, llm: async () => 'x', bridge: mockBridge });
      const result = await loop.run('ejecuta algo', 'Eres un asistente.', [], {
        tools: [
          {
            name: 'exec',
            description: 'ejecuta',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
        pluginManager,
      });

      assert(calls === 2, 'loop continuó tras la denegación (2 llamadas LLM)', `calls: ${calls}`);
      assert(
        executed.length === 0,
        'exec NUNCA llega al bridge (denegado por plugin)',
        `ejecutados: ${JSON.stringify(executed)}`
      );
      assert(
        result.response && result.response.includes('No pude ejecutarlo'),
        'la respuesta final llega del turno posterior a la denegación',
        result.response
      );
      assert(!result.error, 'el loop no falla por la denegación', result.error || '');
    } finally {
      LLMProvider.completeWithTools = original;
    }

    // Sin pluginManager, la tool sí se ejecuta (control: el hook no rompe nada)
    {
      const loop2 = new AgentLoop({ maxIterations: 5, llm: async () => 'x', bridge: mockBridge });
      const original2 = LLMProvider.completeWithTools;
      let calls2 = 0;
      LLMProvider.completeWithTools = async () => {
        calls2++;
        if (calls2 === 1) {
          return {
            content: null,
            toolCalls: [{ tool: 'exec', params: { command: 'echo hola' } }],
          };
        }
        return { content: 'listo', toolCalls: null };
      };
      try {
        await loop2.run('ejecuta', 'Eres un asistente.', [], {
          tools: [
            {
              name: 'exec',
              description: 'ejecuta',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        });
        assert(calls2 === 2, 'control: sin pluginManager el loop avanza igual', `calls: ${calls2}`);
      } finally {
        LLMProvider.completeWithTools = original2;
      }
    }
  }

  // ── 3. sanity: Core.runAgent expone la función y el plugin trivial no rompe ─
  {
    const Core = require('../core/Core.js');
    const { PluginManager } = require('../core/plugins/PluginManager.js');
    const root3 = path.join(tmp, 'root3');
    const dir3 = path.join(root3, 'p3');
    fs.mkdirSync(dir3, { recursive: true });
    fs.writeFileSync(path.join(dir3, 'index.js'), 'module.exports = { register(ctx) {} };');
    const mgr = new PluginManager({ pluginDir: root3, logger: () => {} });
    assert((await mgr.load()) === 1, 'singleton-equivalente carga plugin trivial');
    mgr.registerAll({});
    assert(typeof Core.runAgent === 'function', 'Core.runAgent existe y es invocable');
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
