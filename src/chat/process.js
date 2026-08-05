// Compresión de historial
// Comprime mensajes de assistant repetitivos (fallos, "lo siento"s) para no
// saturar el contexto del LLM con ruido auto-generado.
function _compressHistory(history) {
  const FAIL_PATTERNS = [
    /^Lo siento/i,
    /^No (encontré|pude|se)\s/i,
    /^El comando no/i,
    /^Parece que no/i,
    /^No obtuve/i,
    /^El sistema no/i,
    /falló\.?$/i,
  ];
  function isFailure(msg) {
    return msg.role === 'assistant' && FAIL_PATTERNS.some(p => p.test(msg.content.trim()));
  }
  const result = [];
  let failRun = [];
  for (const msg of history) {
    if (isFailure(msg)) {
      failRun.push(msg);
    } else {
      if (failRun.length > 1) {
        result.push({
          role: 'assistant',
          content: `[${failRun.length} intentos fallidos consecutivos — comprimido]`,
        });
      } else if (failRun.length === 1) {
        result.push(failRun[0]);
      }
      failRun = [];
      result.push(msg);
    }
  }
  // Flush pending failures
  if (failRun.length > 1) {
    result.push({
      role: 'assistant',
      content: `[${failRun.length} intentos fallidos consecutivos — comprimido]`,
    });
  } else if (failRun.length === 1) {
    result.push(failRun[0]);
  }
  return result;
}

// processMessage
async function processMessage(text, files = []) {
  const trimmed = text.trim();
  if (!trimmed && files.length === 0) return;

  // Hide landing on first message
  const landing = document.getElementById('landing');
  if (landing && !landing.classList.contains('hidden')) {
    landing.classList.add('hidden');
  }

  // Comandos / (no usan LLM ni context building)
  if (trimmed.startsWith('/')) {
    addMessage('user', trimmed);
    const cmdCtx = {
      sessionHistory, pushToSession,
      LLMProvider, ipcRenderer,
      sendIPC: (ch, d) => ipcRenderer.send(ch, d),
      addMessage, processMessage,
      openSettings,
      fs, path,
      process: { cwd: () => _workspacePath || assistant.cwd() },
      // NOTA (sandbox): NO se pasa chatGestureEngine por el bridge. El engine
      // corre en la página y guarda el objeto Live2D real; pasarlo a
      // CommandRegistry (que vive en el mundo aislado) dispara una copia
      // profunda síncrona del modelo por contextBridge → la ventana se
      // congela. Se expone solo un wrapper de función (los callbacks sí se
      // proxean barato). /gesto lo usa como ctx.gestureEngine.play(mood).
      gestureEngine: chatGestureEngine
        ? { play: (mood, opts) => chatGestureEngine.play(mood, opts || { priority: 'force' }) }
        : null,
      gestureConfig: chatGestureConfig,
    };

    // Also pass ipcRenderer for commands that use IPC (like /undo)
    cmdCtx.ipcRenderer = ipcRenderer;
    // runCommand ejecuta en el mundo aislado (preload) donde fs/path son los
    // reales de Node — los shims de la página solo tienen join/existsSync y
    // /init, /open, /export fallarían con "readdirSync is not a function".
    const cmdResult = await assistant.runCommand(trimmed, cmdCtx);
    const asstMsg = cmdResult.error
      ? `Error: ${cmdResult.error}`
      : cmdResult.result || '(sin respuesta)';
    addMessage('assistant', asstMsg);
    pushToSession('assistant', `[comando] ${asstMsg}`);
    if (chatGestureEngine) chatGestureEngine.onEvent(cmdResult.error ? 'command_error' : 'command_ok');
    return;
  }

  // @ file references
  const fileResult = FileResolver.buildFileContext(trimmed, _workspacePath || assistant.cwd());

  addMessage('user', trimmed || '(archivo adjunto)', files);
  if (chatGestureEngine) chatGestureEngine.onChat('user', trimmed, chatDetectEmotion);

  if (trimmed) {
    const sessionMsg = fileResult.contexts.length > 0
      ? trimmed + '\n\n' + fileResult.contexts.map(c =>
          `[Contexto: ${c.path}]\n\`\`\`\n${c.content}\n\`\`\``
        ).join('\n\n')
      : trimmed;
    pushToSession('user', sessionMsg);
    ipcRenderer.send('memory-add-turn', { role: 'user', content: sessionMsg });
  }

  showThinking();
  triggerMotion();

  let response;
  let error = null;

  if (openclawAvailable) {
    // NUEVO FLUJO: AgentLoop (Fase 2)
    // processMessage llama a runAgent() vía IPC agent-run. AgentLoop ejecuta
    // el loop LLM→tool→result→LLM→...→texto_final. La respuesta final se
    // genera DESPUÉS de que el LLM vio todos los resultados reales.
    try {
      const { bubble } = addMessage('assistant', '');
      const msgDiv = bubble.parentElement.parentElement;
      const bodyEl = msgDiv.querySelector('.msg-body');

      // Indicador de progreso minimal
      const progressEl = document.createElement('div');
      progressEl.style.cssText = 'font-family:var(--font-mono);font-size:10px;color:var(--text-secondary);padding:2px 0;opacity:.6';
      progressEl.innerHTML = '<span class="loading-spinner">⠋</span> <span class="agent-progress-status">Iniciando...</span>';
      if (bodyEl) bodyEl.appendChild(progressEl);
      _agentProgressEl = progressEl.querySelector('.agent-progress-status');
      _startSpinner(progressEl.querySelector('.loading-spinner'));
      messagesEl.scrollTop = messagesEl.scrollHeight;

      const result = await ipcRenderer.invoke('agent-run', {
        text: trimmed,
      });

      _agentProgressEl = null;
      if (progressEl.parentNode) progressEl.parentNode.removeChild(progressEl);

      if (result.error && !result.response) {
        error = result.error;
        response = `Ocurrió un error: ${result.error}`;
      } else {
        response = result.response || '(sin respuesta)';
      }

      // Escribir respuesta directamente en el bubble existente
      removeThinking();
      if (response) {
        pushToSession('assistant', response);
        ipcRenderer.send('memory-add-turn', { role: 'assistant', content: response });
        bubble.classList.add('markdown');
        bubble.innerHTML = renderMarkdown(response);
        bubble.querySelectorAll('.mermaid').forEach(el => _renderMermaid(el));
        messagesEl.scrollTop = messagesEl.scrollHeight;
        speak(response);
        return;
      }
    } catch (err) {
      console.error('error en agent-run:', err.message);
      error = err.message;
      response = null;
      // Limpiar bubble vacío creado en la línea 1119
      if (bubble) {
        const parent = bubble.parentElement?.parentElement;
        if (parent?.parentNode) parent.parentNode.removeChild(parent);
      }
    }
  }

  if (!response) {
    // Sin herramientas o error: llamada simple al LLM
    try {
      const compressedHistory = _compressHistory([...sessionHistory]);
      const ctx = await ipcRenderer.invoke('grounding-build-context', {
        sessionHistory: compressedHistory,
        activeProvider: LLMProvider.getActiveProvider(),
      });
      if (!ctx || !ctx.messages || !ctx.systemPrompt) {
        throw new Error('context inválido');
      }

      const agentPrompt = AgentManager.getSystemPrompt();
      if (agentPrompt) {
        ctx.systemPrompt = `${agentPrompt}\n\n---\n\n${ctx.systemPrompt}`;
      }

      response = await LLMProvider.complete(ctx.messages, ctx.systemPrompt);
    } catch (err) {
      console.error('error LLM:', err.message);
      response = LLMProvider.getActiveProvider()
        ? 'Algo falló al conectar. Revisa tu conexión o la key.'
        : 'Sin API keys. Usa el boton de configuracion (engranaje) para configurarlas.';
    }
  }

  removeThinking();

  // Mostrar respuesta final
  pushToSession('assistant', response);
  ipcRenderer.send('memory-add-turn', { role: 'assistant', content: response });
  const { bubble } = addMessage('assistant', response);
  bubble.querySelectorAll('.mermaid').forEach(el => _renderMermaid(el));
  messagesEl.scrollTop = messagesEl.scrollHeight;
  speak(response);
}

// Plan UI
async function _executePlanWithUI(plan, msgDiv) {
  activePlanId = plan.id;

  const bubble = msgDiv.querySelector('.msg-bubble');

  const stepLabels = plan.steps.map(s => s.description).join(' → ');
  if (bubble) bubble.textContent = stepLabels;

  const card = document.createElement('div');
  card.className = 'plan-card'; card.id = `plan-${plan.id}`;
  card.innerHTML = `<div class="plan-header"><div class="plan-dot"></div>EJECUTANDO — ${plan.steps.length} PASO${plan.steps.length !== 1 ? 'S' : ''}</div><div class="plan-steps"></div><div class="plan-result" style="display:none"></div>`;
  const stepsEl  = card.querySelector('.plan-steps');
  const resultEl = card.querySelector('.plan-result');
  for (const step of plan.steps) {
    const el = document.createElement('div');
    el.className = 'plan-step'; el.id = `step-${step.id}`;
    el.innerHTML = `<span class="step-icon">⏳</span><span>${step.description}</span>${step.requiresApproval ? '<span style="color:#f59e0b;margin-left:4px">[requiere aprobación]</span>' : ''}`;
    stepsEl.appendChild(el);
  }
  const bodyEl = msgDiv.querySelector('.msg-body');
  if (bodyEl) bodyEl.appendChild(card);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  const result = await ipcRenderer.invoke('openclaw-execute-plan', { plan });

  const dot = card.querySelector('.plan-dot');
  if (dot) { dot.style.animation = 'none'; dot.style.background = result.ok ? '#10b981' : '#ef4444'; }
  const header = card.querySelector('.plan-header');
  if (header) header.style.color = result.ok ? '#10b981' : '#ef4444';
  const headerText = card.querySelector('.plan-header');
  if (headerText) headerText.innerHTML = `<div class="plan-dot" style="background:${result.ok ? '#10b981' : '#ef4444'};animation:none"></div>${result.ok ? 'COMPLETADO' : 'ERROR'} — ${plan.steps.length} PASO${plan.steps.length !== 1 ? 'S' : ''}`;

  if (result.result && result.ok) {
    const txt = typeof result.result === 'string' ? result.result : JSON.stringify(result.result, null, 2);
    if (txt?.trim()) {
      resultEl.textContent = txt;
      resultEl.style.display = 'block';
    }
    _interpretResult(plan, result.result, bubble);
  } else if (!result.ok && result.error) {
    resultEl.textContent = `Error: ${result.error}`;
    resultEl.style.color = '#ef4444';
    resultEl.style.display = 'block';

    // Mismo gap que el del resultado exitoso: si no se persiste, el asistente
    // "olvida" que la acción falló y el siguiente turno no tiene contexto
    // de por qué. No pasa por _interpretResult (no vale la pena gastar
    // una llamada al LLM solo para narrar un error) — se guarda directo.
    const goalDesc = plan?.goal || plan?.steps?.[0]?.description || 'la tarea';
    const errorNote = `No pude completar "${goalDesc}": ${result.error}`;
    pushToSession('assistant', errorNote);
    ipcRenderer.send('memory-add-turn', { role: 'assistant', content: errorNote });
  }

  messagesEl.scrollTop = messagesEl.scrollHeight;
  activePlanId = null;
}

// Plan Approval UI (sistema de dos fases)
// Muestra los pasos del plan con botones Aprobar/Rechazar. El plan se ejecuta
// solo si el usuario hace clic en "Aprobar".
function _showPlanApprovalCard(plan, msgDiv) {
  const bodyEl = msgDiv.querySelector('.msg-body');
  if (!bodyEl) return;

  // Si ya hay una tarjeta de aprobación en este mensaje, reemplazarla
  const existing = bodyEl.querySelector('.plan-approval-card');
  if (existing) existing.remove();

  const card = document.createElement('div');
  card.className = 'plan-card plan-approval-card';
  card.id = `plan-${plan.id}`;

  const stepsHtml = plan.steps.map(s =>
    `<div class="plan-step"><span class="step-icon">~</span><span>${s.description}</span></div>`
  ).join('');

  card.innerHTML = `
    <div class="plan-header">
      <div class="plan-dot" style="background:var(--accent);animation:none"></div>
      PLAN — ${plan.steps.length} PASO${plan.steps.length !== 1 ? 'S' : ''}
    </div>
    <div class="plan-steps">${stepsHtml}</div>
    <div class="plan-approval-actions" style="display:flex;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
      <button class="btn-approve-plan" style="flex:1;padding:8px 16px;border:none;border-radius:6px;background:#10b981;color:#fff;cursor:pointer;font-weight:600">Aprobar y ejecutar</button>
      <button class="btn-reject-plan" style="flex:1;padding:8px 16px;border:none;border-radius:6px;background:var(--bg-input);color:var(--text-secondary);cursor:pointer">Cancelar</button>
    </div>
  `;

  bodyEl.appendChild(card);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  // Handler aprobar
  card.querySelector('.btn-approve-plan').addEventListener('click', () => {
    _handlePlanApprove(plan, msgDiv, card);
  });

  // Handler rechazar
  card.querySelector('.btn-reject-plan').addEventListener('click', () => {
    _handlePlanReject(msgDiv, card);
  });
}

async function _handlePlanApprove(plan, msgDiv, card) {
  // Remover la tarjeta de aprobación — _executePlanWithUI crea su propia UI
  card.remove();

  // Limpiar pending state
  pendingPlan = null;
  pendingLlmResponse = null;
  pendingPlanMsgDiv = null;

  // Ejecutar el plan con la UI existente
  const bubbleEl = msgDiv.querySelector('.msg-bubble');
  if (bubbleEl) bubbleEl.textContent = 'Ejecutando...';
  await _executePlanWithUI(plan, msgDiv);
}

function _handlePlanReject(msgDiv, card) {
  card.remove();

  // Mostrar los pasos del plan como texto en vez de la respuesta cruda del LLM
  // (que suele incluir análisis alucinados de resultados que no ejecutó)
  const bubbleEl = msgDiv.querySelector('.msg-bubble');
  if (bubbleEl) {
    const stepList = pendingPlan
      ? pendingPlan.steps.map((s, i) => `${i + 1}. ${s.description}`).join('\n')
      : 'Plan cancelado.';
    bubbleEl.textContent = '';
    typewriterMarkdown(bubbleEl, `Plan cancelado. Pasos previstos:\n${stepList}`, 15);
  }

  pendingPlan = null;
  pendingLlmResponse = null;
  pendingPlanMsgDiv = null;
}

function _compactResult(rawResult) {
  try {
    const parsed = JSON.parse(rawResult);
    const compact = {};
    for (const [key, val] of Object.entries(parsed)) {
      if (val && typeof val === 'object' && (val.status === 'success' || val.status === 'written_unverified')) {
        compact[key] = { status: val.status, path: val.path, chars: val.newContent?.length ?? 0 };
      } else if (typeof val === 'string') {
        compact[key] = val.length > 800 ? val.slice(0, 800) + '...' : val;
      } else {
        compact[key] = val;
      }
    }
    return JSON.stringify(compact, null, 2);
  } catch {
    return rawResult.length > 2000 ? rawResult.slice(0, 2000) + '\n...[truncado]' : rawResult;
  }
}

async function _interpretResult(plan, rawResult, container) {
  // Buscar el mensaje original del usuario para dar contexto
  const userMsg = [...sessionHistory].reverse().find(m => m.role === 'user');
  const goalDesc = plan?.goal || userMsg?.content || 'la tarea';

  const compactResult = _compactResult(rawResult);
  const summaryHistory = [
    ...sessionHistory,
    { role: 'user', content: `Resultado de ejecutar "${goalDesc}":\n\n${compactResult}\n\nInterpreta esto en tu voz. Responde como el asistente personal, útil y directa, sin preguntar qué sigue.` },
  ];

  let summary = null;
  try {
    const context = await ipcRenderer.invoke('grounding-build-context', {
      sessionHistory: summaryHistory,
      activeProvider: LLMProvider.getActiveProvider(),
    });
    summary = await LLMProvider.completeTask(context.messages, context.systemPrompt);
  } catch(e) {
    console.warn('error interpretando resultado con LLM:', e.message);
  }

  if (summary?.trim()) {
    const el = document.createElement('div');
    el.style.marginTop = '12px';
    container.appendChild(el);
    await typewriterMarkdown(el, summary, 14);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    pushToSession('assistant', summary);
    ipcRenderer.send('memory-add-turn', { role: 'assistant', content: summary });
  } else {
    // Fallback: extraer un resumen legible del resultado crudo
    const fallbackSummary = _resultToText(rawResult, goalDesc);
    const el = document.createElement('div');
    el.style.marginTop = '12px';
    el.style.color = 'var(--text-secondary)';
    el.style.fontSize = '12px';
    el.textContent = fallbackSummary;
    container.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    pushToSession('assistant', fallbackSummary);
    ipcRenderer.send('memory-add-turn', { role: 'assistant', content: fallbackSummary });
  }
}

function _resultToText(rawResult, goalDesc) {
  try {
    const parsed = typeof rawResult === 'string' ? JSON.parse(rawResult) : rawResult;
    const lines = [];

    if (parsed.stdout) {
      const stdout = parsed.stdout.trim();
      // Si es git status, mostrar de forma resumida
      if (stdout.includes('On branch')) {
        const branchLine = stdout.split('\n')[0];
        lines.push(branchLine);
        const changes = (stdout.match(/modified:|new file:|deleted:|renamed:/g) || []).length;
        if (changes > 0) lines.push(`${changes} archivo${changes !== 1 ? 's' : ''} modificado${changes !== 1 ? 's' : ''}`);
        const untracked = (stdout.match(/Untracked files:/) ? stdout.split('Untracked files:')[1]?.trim().split('\n').filter(l => l.trim()).length : 0) || 0;
        if (untracked > 0) lines.push(`${untracked} archivo${untracked !== 1 ? 's' : ''} sin seguimiento`);
      } else if (stdout.length < 500) {
        lines.push(stdout);
      } else {
        lines.push(stdout.slice(0, 300) + '...');
      }
    }
    if (parsed.stderr?.trim()) {
      lines.push(`stderr: ${parsed.stderr.trim().slice(0, 200)}`);
    }
    if (parsed.error) {
      lines.push(`Error: ${parsed.error}`);
    }

    if (lines.length) return lines.join(' | ');
    return `Comando ejecutado: ${typeof goalDesc === 'string' ? goalDesc.slice(0, 80) : goalDesc}`;
  } catch {
    // Si no se puede parsear, mostrar el raw truncado
    const txt = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult);
    return txt.length > 300 ? txt.slice(0, 300) + '...' : txt;
  }
}


// Colorea un patch unified-diff línea por línea: verde lo agregado, rojo
// lo quitado, gris el contexto. Antes la tarjeta de aprobación no
// mostraba el patch en absoluto — el humano aprobaba a ciegas.
function _renderPatchPreview(patchText) {
  if (!patchText) return '';
  const esc = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const lines = patchText.split('\n').map(l => {
    let color = 'var(--text-secondary)';
    if (l.startsWith('+') && !l.startsWith('+++')) color = '#10b981';
    else if (l.startsWith('-') && !l.startsWith('---')) color = '#ef4444';
    else if (l.startsWith('@@')) color = 'var(--accent)';
    return `<div style="color:${color}">${esc(l) || '&nbsp;'}</div>`;
  }).join('');
  return `<div style="font-family:var(--font-mono);font-size:10.5px;background:var(--bg-base);border-radius:4px;padding:8px 10px;margin-bottom:10px;max-height:240px;overflow-y:auto;white-space:pre;line-height:1.5">${lines}</div>`;
}

function _showApprovalCard({ planId, stepId, description, tool, params }) {
  const card = document.createElement('div'); card.className = 'approval-card';
  card.innerHTML = `<div class="approval-title">ACCION DE ALTO IMPACTO — APROBACION REQUERIDA</div><div class="approval-cmd">${description}</div><div style="font-size:10px;color:var(--text-secondary);margin-bottom:10px">Herramienta: <b>${tool}</b>${params.command ? ` · <code>${params.command}</code>` : ''}${params.path ? ` · <code>${params.path}</code>` : ''}</div>${_renderPatchPreview(params.patch)}<div class="approval-actions"><button class="btn-approve" id="approve-${stepId}">Ejecutar</button><button class="btn-deny" id="deny-${stepId}">Cancelar</button></div>`;
  messagesEl.appendChild(card);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  document.getElementById(`approve-${stepId}`)?.addEventListener('click', () => {
    ipcRenderer.send('plan-approval-response', { stepId, approved: true });
    card.style.opacity = '.5'; card.style.pointerEvents = 'none';
  });
  document.getElementById(`deny-${stepId}`)?.addEventListener('click', () => {
    ipcRenderer.send('plan-approval-response', { stepId, approved: false });
    card.style.opacity = '.5'; card.style.pointerEvents = 'none';
  });
}
