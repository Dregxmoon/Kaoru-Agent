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
    return msg.role === 'assistant' && FAIL_PATTERNS.some((p) => p.test(msg.content.trim()));
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
      sessionHistory,
      pushToSession,
      LLMProvider,
      ipcRenderer,
      sendIPC: (ch, d) => ipcRenderer.send(ch, d),
      addMessage,
      processMessage,
      openSettings,
      fs,
      path,
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
      setTtsMuted,
      isTtsMuted,
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
    if (chatGestureEngine)
      chatGestureEngine.onEvent(cmdResult.error ? 'command_error' : 'command_ok');
    return;
  }

  // @ file references
  const fileResult = FileResolver.buildFileContext(trimmed, _workspacePath || assistant.cwd());

  addMessage('user', trimmed || '(archivo adjunto)', files);
  if (chatGestureEngine) chatGestureEngine.onChat('user', trimmed, chatDetectEmotion);

  if (trimmed) {
    const sessionMsg =
      fileResult.contexts.length > 0
        ? trimmed +
          '\n\n' +
          fileResult.contexts
            .map((c) => `[Contexto: ${c.path}]\n\`\`\`\n${c.content}\n\`\`\``)
            .join('\n\n')
        : trimmed;
    pushToSession('user', sessionMsg);
    ipcRenderer.send('memory-add-turn', { role: 'user', content: sessionMsg });
  }

  showThinking();
  triggerMotion();

  // Botón de cancelación: visible durante la generación, envía 'agent-cancel'
  // al main (aborta el AbortController → rompe el stream y el loop).
  const cancelBtn = document.getElementById('cancel-btn');
  if (cancelBtn) cancelBtn.style.display = 'inline-flex';
  const cancelOnce = () => {
    ipcRenderer.send('agent-cancel');
    if (cancelBtn) {
      cancelBtn.style.display = 'none';
      cancelBtn.removeEventListener('click', cancelOnce);
    }
  };
  if (cancelBtn) cancelBtn.addEventListener('click', cancelOnce);

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
      progressEl.style.cssText =
        'font-family:var(--font-mono);font-size:10px;color:var(--text-secondary);padding:2px 0;opacity:.6';
      progressEl.innerHTML =
        '<span class="loading-spinner">⠋</span> <span class="agent-progress-status">Iniciando...</span>';
      if (bodyEl) bodyEl.appendChild(progressEl);
      _agentProgressEl = progressEl.querySelector('.agent-progress-status');
      _startSpinner(progressEl.querySelector('.loading-spinner'));
      messagesEl.scrollTop = messagesEl.scrollHeight;

      // Streaming: acumular fragmentos del LLM y pintarlos en el bubble en
      // vivo (texto plano mientras llega; al final se renderiza markdown).
      let streamBuf = '';
      const streamedSpan = document.createElement('span');
      streamedSpan.style.whiteSpace = 'pre-wrap';
      bubble.appendChild(streamedSpan);
      const offStream = ipcRenderer.on('agent-token', (_e, token) => {
        streamBuf += token;
        streamedSpan.textContent = streamBuf;
        messagesEl.scrollTop = messagesEl.scrollHeight;
      });

      const result = await ipcRenderer.invoke('agent-run', {
        text: trimmed,
      });

      offStream();
      _agentProgressEl = null;
      if (progressEl.parentNode) progressEl.parentNode.removeChild(progressEl);
      if (cancelBtn) {
        cancelBtn.style.display = 'none';
        cancelBtn.removeEventListener('click', cancelOnce);
      }

      // Si el loop fue cancelado por el usuario, no tratar la respuesta
      // parcial como un error — solo mostrar lo que ya se generó.
      if (result.cancelled) {
        removeThinking();
        const partial = result.response || streamBuf.trim();
        if (partial) {
          pushToSession('assistant', partial);
          bubble.classList.add('markdown');
          bubble.innerHTML = renderMarkdown(partial);
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }
        return;
      }

      // La respuesta final autoritativa es `result.response` (el output final
      // del LLM). El buffer de streaming solo sirve de preview en vivo y como
      // fallback si el loop terminó sin una respuesta limpia (max_iterations).
      const finalText =
        result.response && String(result.response).trim()
          ? result.response
          : streamBuf.trim()
            ? streamBuf
            : null;

      if (result.error && !finalText) {
        error = result.error;
        response = `Ocurrió un error: ${result.error}`;
      } else {
        response = finalText || '(sin respuesta)';
      }

      // Escribir respuesta directamente en el bubble existente
      removeThinking();
      if (response) {
        pushToSession('assistant', response);
        ipcRenderer.send('memory-add-turn', { role: 'assistant', content: response });
        bubble.classList.add('markdown');
        bubble.innerHTML = renderMarkdown(response);
        bubble.querySelectorAll('.mermaid').forEach((el) => _renderMermaid(el));
        messagesEl.scrollTop = messagesEl.scrollHeight;
        speak(response);
        return;
      }
    } catch (err) {
      console.error('error en agent-run:', err.message);
      if (cancelBtn) {
        cancelBtn.style.display = 'none';
        cancelBtn.removeEventListener('click', cancelOnce);
      }
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
  bubble.querySelectorAll('.mermaid').forEach((el) => _renderMermaid(el));
  messagesEl.scrollTop = messagesEl.scrollHeight;
  speak(response);
}

// Colorea un patch unified-diff línea por línea: verde lo agregado, rojo
// lo quitado, gris el contexto. Antes la tarjeta de aprobación no
// mostraba el patch en absoluto — el humano aprobaba a ciegas.
function _renderPatchPreview(patchText) {
  if (!patchText) return '';
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = patchText
    .split('\n')
    .map((l) => {
      let color = 'var(--text-secondary)';
      if (l.startsWith('+') && !l.startsWith('+++')) color = '#10b981';
      else if (l.startsWith('-') && !l.startsWith('---')) color = '#ef4444';
      else if (l.startsWith('@@')) color = 'var(--accent)';
      return `<div style="color:${color}">${esc(l) || '&nbsp;'}</div>`;
    })
    .join('');
  return `<div style="font-family:var(--font-mono);font-size:10.5px;background:var(--bg-base);border-radius:4px;padding:8px 10px;margin-bottom:10px;max-height:240px;overflow-y:auto;white-space:pre;line-height:1.5">${lines}</div>`;
}

function _escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Tarjeta de aprobación rica — se muestra cuando el AgentLoop pide permiso para
// una acción de alto impacto. Los datos (description/tool/params) son texto del
// LLM, así que TODO texto interpolado pasa por _escapeHtml (nunca innerHTML crudo).
function _showApprovalCard({ id, tool, params, description }) {
  const card = document.createElement('div');
  card.className = 'approval-card';
  const safeDescription = _escapeHtml(description);
  const safeTool = _escapeHtml(tool);
  const safeParams = {
    command: _escapeHtml(params?.command),
    path: _escapeHtml(params?.path),
  };
  card.innerHTML = `<div class="approval-title">ACCION DE ALTO IMPACTO — APROBACION REQUERIDA</div><div class="approval-cmd">${safeDescription}</div><div style="font-size:10px;color:var(--text-secondary);margin-bottom:10px">Herramienta: <b>${safeTool}</b>${safeParams.command ? ` · <code>${safeParams.command}</code>` : ''}${safeParams.path ? ` · <code>${safeParams.path}</code>` : ''}</div>${_renderPatchPreview(params?.patch)}<div class="approval-actions"><button class="btn-approve" id="approve-${id}">Ejecutar</button><button class="btn-deny" id="deny-${id}">Cancelar</button></div>`;
  messagesEl.appendChild(card);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  document.getElementById(`approve-${id}`)?.addEventListener('click', () => {
    ipcRenderer.send('agent-approval-response', { id, approved: true });
    card.style.opacity = '.5';
    card.style.pointerEvents = 'none';
  });
  document.getElementById(`deny-${id}`)?.addEventListener('click', () => {
    ipcRenderer.send('agent-approval-response', { id, approved: false });
    card.style.opacity = '.5';
    card.style.pointerEvents = 'none';
  });
}
