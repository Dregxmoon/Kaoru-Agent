// @ts-nocheck
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

// ── Gestos dirigidos por el LLM ─────────────────────────────────────────────
// El LLM intercala marcadores (gesto: <mood o nombre>) en su respuesta. Aquí se
// detectan, se ejecutan en el GestureEngine en vivo y se eliminan del texto que
// se muestra y se habla. El vocabulario lo declara el system prompt (extraído
// del modelo real); el motor orquesta la reproducción.
const _gestureMarkerRe = /\(gesto:\s*([a-z_0-9\u3040-\u30ff\u4e00-\u9fff]+)\)/gi;

// Ejecuta un mood/nombre de gesto en el motor del chat, sin romper la
// generación si el motor aún no está listo o el mood es desconocido (el motor
// ya cae a su fallback).
function _playGesture(mood) {
  try {
    if (chatGestureEngine && chatGestureEngine.enabled && mood) {
      chatGestureEngine.setEmotion(String(mood).trim());
    }
  } catch (e) {
    console.warn('[gesto] no se pudo reproducir:', mood, e.message);
  }
}

// Extrae todos los marcadores completos de un texto y devuelve el texto limpio
// + la lista { pos, mood } donde pos es la posición en el texto limpio (para
// que revealText los dispare cuando el cursor revelado los alcanza).
function _parseGestureMarkers(text) {
  const markers = [];
  let clean = '';
  let last = 0;
  let m;
  const t = String(text || '');
  _gestureMarkerRe.lastIndex = 0;
  while ((m = _gestureMarkerRe.exec(t))) {
    clean += t.slice(last, m.index);
    markers.push({ pos: clean.length, mood: m[1] });
    last = m.index + m[0].length;
  }
  clean += t.slice(last);
  return { clean, markers };
}

// En streaming, un marcador puede llegar cortado entre tokens ("(gesto: ha" →
// "ppy)"). Esta función dispara los marcadores completos acumulados y los quita
// del buffer; el fragmento sin cerrar se oculta del render (queda al final).
function _processStreamingGestures(buf) {
  let out = String(buf || '');
  let m;
  _gestureMarkerRe.lastIndex = 0;
  while ((m = _gestureMarkerRe.exec(out))) {
    _playGesture(m[1]);
  }
  out = out.replace(_gestureMarkerRe, '');
  return out;
}

// Oculta del render un marcador que aún no se ha cerrado (está en curso).
function _maskUnclosedGesture(text) {
  const t = String(text || '');
  const openIdx = t.lastIndexOf('(gesto:');
  if (openIdx === -1) return t;
  const rest = t.slice(openIdx);
  if (rest.indexOf(')') !== -1) return t;
  return t.slice(0, openIdx);
}

// processMessage
async function processMessage(text, files = []) {
  const trimmed = text.trim();
  if (!trimmed && files.length === 0) return;

  // Ocultar el grafo de memoria inline al enviar un mensaje (no al usar
  // /memoria, que lo reabre).
  if (!trimmed.startsWith('/memoria') && typeof hideNodes === 'function') hideNodes();

  // Hide landing on first message
  const landing = document.getElementById('landing');
  if (landing && !landing.classList.contains('hidden')) {
    landing.classList.add('hidden');
  }

  // Comandos / (no usan LLM ni context building)
  if (trimmed.startsWith('/')) {
    addMessage('user', trimmed);

    // Con sandbox:true el ctx del CommandRegistry se construye en MAIN
    // (ipc/chat-handlers.js) con fs/path reales. La página envía SOLO datos
    // serializables (pageData) y un ctx donde las funciones de página son
    // stubs que el main resuelve por roundtrip (chat-ui-call). El main muta
    // su copia de sessionHistory (los comandos hacen push/splice) y la
    // devuelve al final para que la página sincronice su array.
    const pageData = {
      sessionHistory,
      gestureConfig: chatGestureConfig || null,
      gestureAvailable: !!chatGestureEngine,
      ttsMuted: isTtsMuted(),
      workspacePath: _workspacePath,
    };
    const cmdResult = await assistant.runCommand(trimmed, pageData);
    if (cmdResult && Array.isArray(cmdResult.sessionHistory)) {
      sessionHistory.splice(0, sessionHistory.length, ...cmdResult.sessionHistory);
    }
    const asstMsg =
      cmdResult && cmdResult.result
        ? cmdResult.result.error
          ? `Error: ${cmdResult.result.error}`
          : cmdResult.result.result || '(sin respuesta)'
        : '(sin respuesta)';
    addMessage('assistant', asstMsg);
    pushToSession('assistant', `[comando] ${asstMsg}`);
    if (chatGestureEngine)
      chatGestureEngine.onEvent(
        cmdResult && cmdResult.result && cmdResult.result.error ? 'command_error' : 'command_ok'
      );
    return;
  }

  // @ file references
  const projectCwd = _workspacePath || (await assistant.cwd().catch(() => null));
  const fileResult = await FileResolver.buildFileContext(trimmed, projectCwd);

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
  resetActivities();
  resetPlanBlock();

  // Botón de cancelación: visible durante la generación. Aborta el agent-run
  // openclaw (agent-cancel → AbortController del main) Y el flujo simple
  // (chat-llm-cancel → AbortController del main, en ipc/chat-handlers.js). El
  // AbortSignal del renderer no puede cruzar el contextBridge, por eso el
  // controller del flujo simple vive en main.
  const cancelBtn = document.getElementById('cancel-btn');
  let cancelArmed = true;
  if (cancelBtn) cancelBtn.style.display = 'inline-flex';
  const cancelOnce = () => {
    if (!cancelArmed) return;
    cancelArmed = false;
    ipcRenderer.send('agent-cancel');
    LLMProvider.cancelSimple();
    if (cancelBtn) {
      cancelBtn.style.display = 'none';
      cancelBtn.removeEventListener('click', cancelOnce);
    }
  };
  if (cancelBtn) cancelBtn.addEventListener('click', cancelOnce);
  const disarmCancel = () => {
    cancelArmed = false;
    if (cancelBtn) {
      cancelBtn.style.display = 'none';
      cancelBtn.removeEventListener('click', cancelOnce);
    }
  };

  let response;
  let error = null;

  if (openclawAvailable && getAgentMode() === 'agent') {
    // NUEVO FLUJO: AgentLoop (Fase 2)
    // processMessage llama a runAgent() vía IPC agent-run. AgentLoop ejecuta
    // el loop LLM→tool→result→LLM→...→texto_final. La respuesta final se
    // genera DESPUÉS de que el LLM vio todos los resultados reales.
    try {
      const { bubble } = addMessage('assistant', '');
      // La clase markdown se añade desde el inicio para que el streaming en
      // vivo (renderMarkdown incremental) use los mismos estilos que la
      // respuesta final.
      bubble.classList.add('markdown');
      // Los bloques de actividad se insertan antes de este bubble (ancla).
      setActivityAnchor(bubble.parentElement.parentElement);
      // El HUD del plan (plan-then-act) usa el mismo ancla.
      setPlanAnchor(bubble.parentElement.parentElement);

      // El progreso de tools llega por 'agent-progress' y se dibuja como
      // bloques de actividad (activityFromProgress en ui.js) en el feed.

      // Streaming: acumular fragmentos del LLM y pintarlos en el bubble en
      // vivo. Se renderiza markdown incrementalmente (throttle ~80ms) para
      // que el texto se vea limpio mientras se escribe, con cursor parpadeante
      // (patrón opencode). Al final se renderiza markdown sobre el bubble.
      let streamBuf = '';
      let firstToken = false;
      let mdTimer = 0;
      const streamedSpan = document.createElement('span');
      streamedSpan.className = 'stream-text';
      bubble.appendChild(streamedSpan);
      const cursor = document.createElement('span');
      cursor.className = 'stream-cursor';
      streamedSpan.appendChild(cursor);
      const paintStream = () => {
        mdTimer = 0;
        streamedSpan.innerHTML = renderMarkdown(_maskUnclosedGesture(streamBuf), {
          streaming: true,
        });
        streamedSpan.appendChild(cursor);
        messagesEl.scrollTop = messagesEl.scrollHeight;
      };
      const offStream = ipcRenderer.on('agent-token', (_e, token) => {
        if (!firstToken) {
          firstToken = true;
          removeThinking();
          setAgentState('streaming', 'Respondiendo');
        }
        streamBuf += token;
        // Gestos del LLM en vivo: detectar marcadores (gesto: x) a medida que
        // llegan los tokens, ejecutarlos y sacarlos del texto visible.
        streamBuf = _processStreamingGestures(streamBuf);
        if (!mdTimer) mdTimer = setTimeout(paintStream, 80);
      });

      const result = await ipcRenderer.invoke('agent-run', {
        text: trimmed,
      });

      offStream();
      if (mdTimer) {
        clearTimeout(mdTimer);
        mdTimer = 0;
      }
      if (cursor.parentNode) cursor.remove();
      disarmCancel();

      // Si el loop fue cancelado por el usuario, no tratar la respuesta
      // parcial como un error — solo mostrar lo que ya se generó.
      if (result.cancelled) {
        removeThinking();
        const partialRaw = result.response || streamBuf.trim();
        const partial = partialRaw ? _parseGestureMarkers(partialRaw).clean : '';
        if (partial) {
          pushToSession('assistant', partial);
          bubble.classList.add('markdown');
          bubble.innerHTML = renderMarkdown(partial, { path: window.__lastWritePath || '' });
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }
        setAgentState('done', 'Cancelado');
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
        // Limpiar marcadores (gesto: x) que el texto final pudiera reintroducir
        // y ejecutarlos; el GestureEngine deduplica por cooldown de mood.
        const parsed = _parseGestureMarkers(response);
        response = parsed.clean;
        parsed.markers.forEach((g) => _playGesture(g.mood));
        pushToSession('assistant', response);
        ipcRenderer.send('memory-add-turn', { role: 'assistant', content: response });
        bubble.classList.add('markdown');
        bubble.innerHTML = renderMarkdown(response, { path: window.__lastWritePath || '' });
        bubble.querySelectorAll('.mermaid').forEach((el) => _renderMermaid(el));
        messagesEl.scrollTop = messagesEl.scrollHeight;
        setAgentState('done', 'Listo');
        speak(response);
        return;
      }
    } catch (err) {
      console.error('error en agent-run:', err.message);
      disarmCancel();
      error = err.message;
      response = null;
      setAgentState('error', 'Error');
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

      const agentPrompt = await AgentManager.getSystemPrompt();
      if (agentPrompt) {
        ctx.systemPrompt = `${agentPrompt}\n\n---\n\n${ctx.systemPrompt}`;
      }

      // Cancelable: el AbortController vive en MAIN (chat-llm-complete/
      // chat-llm-cancel en ipc/chat-handlers.js); el abort se devuelve como
      // { aborted: true } porque AbortError no serializa code/name por IPC.
      const llm = await LLMProvider.complete(ctx.messages, ctx.systemPrompt);
      if (llm && llm.aborted) {
        disarmCancel();
        removeThinking();
        setAgentState('done', 'Cancelado');
        return;
      }
      if (llm && llm.error) throw new Error(llm.error);
      response = llm && llm.response ? llm.response : null;
    } catch (err) {
      disarmCancel();
      console.error('error LLM:', err.message);
      response = LLMProvider.getActiveProvider()
        ? 'Algo falló al conectar. Revisa tu conexión o la key.'
        : 'Sin API keys. Usa el boton de configuracion (engranaje) para configurarlas.';
      setAgentState('error', 'Error');
    }
  }

  disarmCancel();
  removeThinking();
  setAgentState('streaming', 'Respondiendo');

  // Mostrar respuesta final con revelado progresivo de caracteres y cursor;
  // renderiza markdown en vivo durante la escritura y queda renderizado al
  // terminar (los bloques mermaid se resuelven al final).
  const parsed = _parseGestureMarkers(response);
  response = parsed.clean;
  pushToSession('assistant', response);
  ipcRenderer.send('memory-add-turn', { role: 'assistant', content: response });
  const { bubble } = addMessage('assistant', '');
  bubble.classList.add('markdown');
  const reveal = revealText(bubble, response, {
    markdown: true,
    gestures: parsed.markers,
    onGesture: _playGesture,
  });
  await reveal.done;
  bubble.classList.add('markdown');
  bubble.innerHTML = renderMarkdown(response);
  bubble.querySelectorAll('.mermaid').forEach((el) => _renderMermaid(el));
  messagesEl.scrollTop = messagesEl.scrollHeight;
  setAgentState('done', 'Listo');
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
  // Aviso de sandbox desactivado: solo cuando la acción ejecuta comandos y el
  // server reporta aislamiento de proceso inactivo (openclawSandbox === false).
  const runsCommand = /^(exec|code_execution)$/i.test(safeTool) || Boolean(safeParams.command);
  const sandboxWarning =
    runsCommand && openclawSandbox === false
      ? `<div class="approval-sandbox-warn">Ejecución de comandos SIN aislamiento de proceso (bwrap no disponible)${openclawSandboxReason ? ` — ${_escapeHtml(openclawSandboxReason)}` : ''}. Esta acción corre con permisos reales del sistema.</div>`
      : '';
  card.innerHTML = `<div class="approval-title">ACCION DE ALTO IMPACTO — APROBACION REQUERIDA</div><div class="approval-cmd">${safeDescription}</div><div style="font-size:10px;color:var(--text-secondary);margin-bottom:10px">Herramienta: <b>${safeTool}</b>${safeParams.command ? ` · <code>${safeParams.command}</code>` : ''}${safeParams.path ? ` · <code>${safeParams.path}</code>` : ''}</div>${sandboxWarning}${_renderPatchPreview(params?.patch)}<div class="approval-actions"><button class="btn-approve" id="approve-${id}">Ejecutar</button><button class="btn-always" id="always-${id}">Siempre</button><button class="btn-deny" id="deny-${id}">Cancelar</button></div>`;
  messagesEl.appendChild(card);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  document.getElementById(`approve-${id}`)?.addEventListener('click', () => {
    ipcRenderer.send('agent-approval-response', { id, approved: true });
    card.style.opacity = '.5';
    card.style.pointerEvents = 'none';
  });
  document.getElementById(`always-${id}`)?.addEventListener('click', () => {
    ipcRenderer.send('agent-approval-response', { id, approved: true, always: true });
    card.style.opacity = '.5';
    card.style.pointerEvents = 'none';
  });
  document.getElementById(`deny-${id}`)?.addEventListener('click', () => {
    ipcRenderer.send('agent-approval-response', { id, approved: false });
    card.style.opacity = '.5';
    card.style.pointerEvents = 'none';
  });
}
