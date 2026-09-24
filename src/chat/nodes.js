// @ts-nocheck
/* exported attachMemoryContext */
// Memory Explorer: isolated renderer, data and mutations cross the preload allowlist.
const NODE_COLORS = {
  Episode: '#76a6ff',
  Belief: '#bd97ff',
  Preference: '#ff92c5',
  Project: '#58ded5',
  User: '#ffd675',
};
const NODE_SYMBOLS = { Episode: '●', Belief: '◆', Preference: '♥', Project: '■', User: '★' };
let memoryExplorer = null;
let memoryExplorerGeneration = 0;
const memoryText = (value) => escapeHtml(String(value ?? ''));
const memoryDate = (value) =>
  value
    ? new Date(value).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' })
    : 'Sin registro';
const memoryNormalize = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

function openNodes(options = {}) {
  return renderGraph(options);
}
function hideNodes() {
  if (!memoryExplorer) return;
  memoryExplorer.el.classList.add('memory-minimized');
  memoryExplorer.el.classList.remove('memory-fullscreen');
  memoryExplorer.el.removeAttribute('aria-modal');
  memoryExplorer.el.setAttribute('role', 'region');
  memoryExplorer.el.querySelector('[data-action="fullscreen"]').textContent = 'Pantalla completa';
}

async function renderGraph(options = {}) {
  const generation = ++memoryExplorerGeneration;
  const previous = memoryExplorer;
  let data;
  try {
    data = await ipcRenderer.invoke('memory-explorer');
  } catch {
    data = { ok: false };
  }
  if (generation !== memoryExplorerGeneration) return;
  previous?.events?.abort();
  document.getElementById('nodes-inline')?.remove();
  const el = document.createElement('section');
  el.id = 'nodes-inline';
  el.className = 'nodes-inline memory-explorer';
  el.setAttribute('aria-label', 'Explorador de memoria');
  const state = (memoryExplorer = {
    el,
    data,
    view: previous?.view || 'graph',
    type: previous?.type || '',
    query: options.query ?? previous?.query ?? '',
    topic: options.topic ?? previous?.topic ?? '',
    page: 0,
    selected: null,
    highlight: new Set(options.ids || []),
    scale: 1,
    tx: 0,
    ty: 0,
    relations: new Set(['explicit', 'semantic']),
    detailTicket: 0,
    events: new AbortController(),
  });
  if (options.ids?.length) {
    state.query = '';
    state.topic = '';
    state.type = '';
  }
  el.innerHTML = `<header class="nodes-inline-head"><strong>MEMORIA — CONEXIONES</strong>
    <div><button data-action="fullscreen">Pantalla completa</button><button data-action="minimize" aria-label="Minimizar memoria">−</button><button data-action="restore">Abrir</button></div></header>
    <div class="memory-content"><div class="memory-toolbar">
      <input class="memory-search" type="search" placeholder="Buscar memoria…" aria-label="Buscar memoria" value="${memoryText(state.query)}">
      <details class="memory-filters"><summary>Filtros</summary><fieldset><legend>Relaciones</legend>
      ${[
        ['explicit', 'Explícitas'],
        ['semantic', 'Semánticas'],
        ['conversation', 'Misma conversación'],
        ['temporal', 'Proximidad temporal'],
      ]
        .map(
          ([key, label]) =>
            `<label><input type="checkbox" data-relation="${key}" ${state.relations.has(key) ? 'checked' : ''}>${label}</label>`
        )
        .join('')}</fieldset></details>
      <button data-action="center">Centrar</button><button data-action="zoomout" aria-label="Alejar">−</button><button data-action="zoomin" aria-label="Acercar">+</button>
      <details><summary aria-label="Más opciones">⋯</summary><button data-action="export">Exportar</button></details>
    </div><nav class="memory-tabs" aria-label="Vista de memoria">${[
      ['graph', 'Grafo'],
      ['list', 'Lista'],
      ['timeline', 'Línea temporal'],
    ]
      .map(([key, label]) => `<button data-view="${key}">${label}</button>`)
      .join('')}</nav>
    <nav class="memory-types" aria-label="Tipo de memoria">${[
      ['', 'Todo'],
      ['Project', 'Proyectos'],
      ['Preference', 'Preferencias'],
      ['User', 'Personas'],
      ['Episode', 'Episodios'],
      ['Belief', 'Creencias'],
    ]
      .map(
        ([key, label]) => `<button data-type="${key}">${NODE_SYMBOLS[key] || ''} ${label}</button>`
      )
      .join('')}</nav>
    <div class="memory-status" role="status" aria-live="polite"></div>
    <div class="memory-workspace"><div class="memory-main"><div class="memory-breadcrumb"></div><div class="nodes-inline-body"></div><div class="memory-pagination"></div></div>
    <aside class="nodes-inline-detail" aria-label="Detalle de memoria" hidden></aside></div>
    <details class="memory-legend"><summary>Leyenda</summary>${Object.keys(NODE_COLORS)
      .map((t) => `<span style="color:${NODE_COLORS[t]}">${NODE_SYMBOLS[t]} ${t}</span>`)
      .join(
        ''
      )}<p>Las conexiones semánticas agrupan temas. La proximidad temporal no demuestra que dos recuerdos provengan de la misma conversación.</p></details>
    <section class="memory-gaps"><h3>Aún no sé sobre ti</h3><div></div></section>
    <form class="memory-question"><label>Pregúntale a tu memoria<input placeholder="¿Qué recuerdas sobre Kaoru?" aria-label="Pregunta sobre la memoria" required maxlength="200"></label><button>Consultar</button></form>
    <div class="memory-answer" aria-live="polite"></div></div>`;
  messagesEl.appendChild(el);
  function setFullscreen(enabled) {
    el.classList.toggle('memory-fullscreen', enabled);
    el.querySelector('[data-action="fullscreen"]').textContent = enabled
      ? 'Volver al chat'
      : 'Pantalla completa';
    el.setAttribute('role', enabled ? 'dialog' : 'region');
    if (enabled) el.setAttribute('aria-modal', 'true');
    else el.removeAttribute('aria-modal');
  }
  setFullscreen(Boolean(previous?.el.classList.contains('memory-fullscreen')));
  const status = (text) => {
    el.querySelector('.memory-status').textContent = text;
  };
  state.status = status;
  if (!data?.ok) {
    status('No se pudo cargar la memoria. Vuelve a abrir /memoria para reintentar.');
    return;
  }
  state.nodes = data.nodes || [];
  state.edges = data.edges || [];
  state.byId = new Map(state.nodes.map((n) => [n.id, n]));
  state.adj = new Map();
  for (const edge of state.edges) {
    for (const [a, b] of [
      [edge.source, edge.target],
      [edge.target, edge.source],
    ]) {
      if (!state.adj.has(a)) state.adj.set(a, []);
      state.adj.get(a).push({ id: b, edge });
    }
  }
  el.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.view) {
      state.view = button.dataset.view;
      state.page = 0;
      drawMemory(state);
    }
    if (button.hasAttribute('data-type')) {
      state.type = button.dataset.type;
      state.page = 0;
      drawMemory(state);
    }
    if (button.dataset.node) inspectMemoryNode(state, Number(button.dataset.node));
    if (button.hasAttribute('data-topic')) {
      state.topic = button.dataset.topic;
      state.page = 0;
      state.scale = 1;
      drawMemory(state);
    }
    const action = button.dataset.action;
    if (action === 'fullscreen') {
      setFullscreen(!el.classList.contains('memory-fullscreen'));
    }
    if (action === 'minimize') hideNodes();
    if (action === 'restore') el.classList.remove('memory-minimized');
    if (action === 'center') {
      state.scale = 1;
      state.tx = 0;
      state.ty = 0;
      memoryTransform(state);
    }
    if (action === 'zoomin' || action === 'zoomout') {
      state.scale = Math.min(4, Math.max(0.5, state.scale * (action === 'zoomin' ? 1.2 : 1 / 1.2)));
      memoryTransform(state);
    }
    if (action === 'back') {
      state.topic = '';
      state.page = 0;
      drawMemory(state);
    }
    if (action === 'prev' || action === 'next') {
      state.page += action === 'next' ? 1 : -1;
      drawMemory(state);
    }
    if (action === 'close-detail') {
      state.detailTicket++;
      state.selected = null;
      el.querySelector('aside').hidden = true;
      drawMemory(state);
    }
    if (action === 'export') {
      try {
        const r = await ipcRenderer.invoke('memory-export');
        if (!r.ok && !r.cancelled) status('No se pudo exportar la memoria.');
      } catch {
        status('No se pudo exportar la memoria.');
      }
    }
  });
  let searchTimer;
  el.querySelector('.memory-search').addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = event.target.value;
      state.topic = '';
      state.page = 0;
      state.scale = 1;
      state.tx = 0;
      state.ty = 0;
      drawMemory(state);
    }, 150);
  });
  el.querySelectorAll('[data-relation]').forEach((input) =>
    input.addEventListener('change', () => {
      if (input.checked) state.relations.add(input.dataset.relation);
      else state.relations.delete(input.dataset.relation);
      drawMemory(state);
    })
  );
  el.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setFullscreen(false);
    if (event.key === 'Tab' && el.classList.contains('memory-fullscreen')) {
      const focusable = [
        ...el.querySelectorAll('button:not(:disabled),input,textarea,summary,[tabindex="0"]'),
      ].filter((n) => n.getClientRects().length);
      const first = focusable[0],
        last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  });
  window.addEventListener('resize', () => drawMemory(state), { signal: state.events.signal });
  el.querySelector('.memory-question').addEventListener('submit', (event) => {
    event.preventDefault();
    const text = event.target.querySelector('input').value;
    const terms = memoryNormalize(text)
      .replace(/[¿?.,!]/g, '')
      .split(/\s+/)
      .filter(
        (t) =>
          t.length > 2 &&
          ![
            'que',
            'recuerdas',
            'sabes',
            'sobre',
            'acerca',
            'del',
            'las',
            'los',
            'una',
            'tienes',
            'memoria',
          ].includes(t)
      );
    const matches = state.nodes.filter(
      (n) =>
        terms.length &&
        terms.every((t) => memoryNormalize(`${n.label} ${n.content} ${n.topic}`).includes(t))
    );
    const topics = [...new Set(matches.map((n) => n.topic))];
    const answer = el.querySelector('.memory-answer');
    answer.innerHTML = `<p>${matches.length} recuerdos encontrados en el inventario cargado.${data.truncated ? ' El inventario está limitado a 10 000 recuerdos.' : ''}</p><p>${memoryText(topics.slice(0, 8).join(' · '))}</p>${matches.length ? '<button>Mostrar en el grafo</button>' : ''}`;
    answer.querySelector('button')?.addEventListener('click', () => {
      state.highlight = new Set(matches.map((n) => n.id));
      state.query = '';
      state.topic = '';
      state.type = '';
      state.view = 'graph';
      state.page = 0;
      el.querySelector('.memory-search').value = '';
      drawMemory(state);
    });
  });
  drawMemory(state);
  renderMemoryGaps(state);
  _scrollMessagesToBottom();
}

function memoryTransform(state) {
  state.el
    .querySelector('.memory-viewport')
    ?.setAttribute(
      'transform',
      `translate(${450 * (1 - state.scale) + state.tx} ${300 * (1 - state.scale) + state.ty}) scale(${state.scale})`
    );
}
function drawMemory(state) {
  const { el } = state;
  if (!el.isConnected) return;
  el.querySelectorAll('[data-view]').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.view === state.view))
  );
  el.querySelectorAll('[data-type]').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.type === state.type))
  );
  const query = memoryNormalize(state.query);
  let filtered = state.nodes.filter(
    (n) =>
      (!state.type || n.type === state.type) &&
      (!state.topic || n.topic === state.topic) &&
      (!query || memoryNormalize(`${n.label} ${n.content} ${n.tags.join(' ')}`).includes(query))
  );
  if (state.highlight.size && !query) filtered = filtered.filter((n) => state.highlight.has(n.id));
  filtered.sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt || a.id - b.id
  );
  if (state.view === 'timeline') filtered.sort((a, b) => b.createdAt - a.createdAt || a.id - b.id);
  const body = el.querySelector('.nodes-inline-body');
  const pagination = el.querySelector('.memory-pagination');
  el.querySelector('.memory-breadcrumb').innerHTML =
    `${state.topic ? `<button data-action="back">← Todos los temas</button> ${memoryText(state.topic)}` : ''}${state.highlight.size ? '<button data-action="clear-focus">Quitar foco de memorias</button>' : ''}`;
  el.querySelector('[data-action="clear-focus"]')?.addEventListener('click', () => {
    state.highlight.clear();
    drawMemory(state);
  });
  state.status(
    `${filtered.length} recuerdos${state.data.truncated ? ' · Se muestran como máximo 10 000; hay más recuerdos guardados.' : ''}${state.data.usingFallback ? ' · Memoria persistente no disponible.' : ''}`
  );
  if (!filtered.length) {
    body.innerHTML = '<p class="nodes-inline-empty">No hay recuerdos que coincidan.</p>';
    pagination.innerHTML = '';
    return;
  }
  const cluster = state.view === 'graph' && !state.topic && !query && !state.highlight.size;
  const pageSize = state.view === 'graph' ? (el.clientWidth < 600 ? 24 : 90) : 100;
  let items = filtered;
  if (cluster) {
    const groups = new Map();
    for (const n of filtered) {
      if (!groups.has(n.topic)) groups.set(n.topic, []);
      groups.get(n.topic).push(n);
    }
    items = [...groups]
      .map(([topic, nodes]) => ({ topic, nodes }))
      .sort((a, b) => b.nodes.length - a.nodes.length);
  }
  state.page = Math.max(0, Math.min(state.page, Math.ceil(items.length / pageSize) - 1));
  let visible = items.slice(state.page * pageSize, (state.page + 1) * pageSize);
  pagination.innerHTML =
    items.length > pageSize
      ? `<button data-action="prev" ${state.page === 0 ? 'disabled' : ''}>Anterior</button><span>${state.page + 1} / ${Math.ceil(items.length / pageSize)}</span><button data-action="next" ${(state.page + 1) * pageSize >= items.length ? 'disabled' : ''}>Siguiente</button>`
      : '';
  if (cluster) {
    body.innerHTML = `<div class="memory-clusters">${visible.map((g) => `<button data-topic="${memoryText(g.topic)}"><strong>${memoryText(g.topic)}</strong><span>${g.nodes.length} recuerdos</span><small>Abrir tema →</small></button>`).join('')}</div>`;
    return;
  }
  if (state.view !== 'graph') {
    let lastDay = '';
    body.innerHTML = `<div class="memory-list">${visible
      .map((n) => {
        const day = n.createdAt
          ? new Date(n.createdAt).toLocaleDateString('es', { dateStyle: 'long' })
          : 'Fecha desconocida';
        const heading =
          state.view === 'timeline' && day !== lastDay ? `<h3>${memoryText(day)}</h3>` : '';
        lastDay = day;
        return `${heading}<button data-node="${n.id}" class="memory-row ${state.selected === n.id ? 'selected' : ''}"><span style="color:${NODE_COLORS[n.type] || '#aaa'}">${NODE_SYMBOLS[n.type] || '●'}</span><span><strong>${n.pinned ? '★ ' : ''}${memoryText(n.label)}</strong><small>${memoryText(n.content.slice(0, 170))}</small></span><span>${memoryText(n.type)}</span></button>`;
      })
      .join('')}</div>`;
    return;
  }
  const matched = new Set(visible.map((n) => n.id));
  // Include a bounded one-hop context for search and response attribution.
  if (query || state.highlight.size) {
    for (const n of [...visible])
      for (const link of state.adj.get(n.id) || []) {
        if (visible.length >= pageSize + 20) break;
        if (
          !matched.has(link.id) &&
          state.relations.has(link.edge.category) &&
          !visible.some((v) => v.id === link.id)
        ) {
          const neighbor = state.byId.get(link.id);
          if (neighbor) visible.push(neighbor);
        }
      }
  }
  const columns = Math.min(visible.length, Math.ceil(Math.sqrt(visible.length * 1.4)));
  const pixelScale = 900 / Math.max(300, body.clientWidth);
  const radius = Math.max(23, 16 * pixelScale);
  const labelSize = Math.max(14, 12 * pixelScale);
  const labelChars = Math.max(
    5,
    Math.min(22, Math.floor(770 / Math.max(1, columns - 1) / (labelSize * 0.6)) - 2)
  );
  const rows = Math.ceil(visible.length / columns);
  const positions = new Map(
    visible.map((n, i) => [
      n.id,
      {
        x: columns === 1 ? 450 : 65 + ((i % columns) * 770) / (columns - 1),
        y: rows === 1 ? 300 : 55 + (Math.floor(i / columns) * 470) / (rows - 1),
      },
    ])
  );
  body.innerHTML = `<svg viewBox="0 0 900 620" aria-label="Relaciones entre recuerdos"><g class="memory-viewport">${state.edges
    .filter(
      (e) => positions.has(e.source) && positions.has(e.target) && state.relations.has(e.category)
    )
    .map((e) => {
      const a = positions.get(e.source),
        b = positions.get(e.target);
      return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${e.category === 'explicit' ? '#b7c4df' : '#638b92'}" stroke-opacity=".6" stroke-width="1.5"><title>${memoryText(e.type)}</title></line>`;
    })
    .join('')}
    ${visible
      .map((n) => {
        const p = positions.get(n.id),
          selected = state.selected === n.id;
        return `<g data-node="${n.id}" role="button" tabindex="0" aria-label="${memoryText(`${n.type}: ${n.label}`)}" class="memory-node ${selected ? 'selected' : ''} ${state.highlight.has(n.id) ? 'memory-used' : ''}" opacity="${matched.has(n.id) ? 1 : 0.25}" transform="translate(${p.x} ${p.y})"><title>${memoryText(`${n.label}\n${n.content}`)}</title><circle r="${radius}" fill="${selected ? '#405575' : '#171c27'}" stroke="${selected ? '#fff' : NODE_COLORS[n.type] || '#aaa'}" stroke-width="${selected ? 4 : 1}"/><text text-anchor="middle" dominant-baseline="central" font-size="${Math.round(radius * 1.2)}" fill="${NODE_COLORS[n.type] || '#aaa'}">${NODE_SYMBOLS[n.type] || '●'}</text><text y="${radius + labelSize + 4}" text-anchor="middle" fill="#eee" font-size="${labelSize}">${memoryText(n.label.length > labelChars ? n.label.slice(0, labelChars) + '…' : n.label)}</text></g>`;
      })
      .join('')}</g></svg>`;
  const svg = body.querySelector('svg');
  let origin = null,
    dragged = false;
  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    origin = { x: e.clientX, y: e.clientY, tx: state.tx, ty: state.ty };
    dragged = false;
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove', (e) => {
    if (!origin) return;
    const dx = e.clientX - origin.x,
      dy = e.clientY - origin.y;
    dragged ||= Math.hypot(dx, dy) > 4;
    state.tx = origin.tx + (dx * 900) / svg.getBoundingClientRect().width;
    state.ty = origin.ty + (dy * 620) / svg.getBoundingClientRect().height;
    memoryTransform(state);
  });
  svg.addEventListener('pointerup', (e) => {
    origin = null;
    if (!dragged) {
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-node]');
      if (target) inspectMemoryNode(state, Number(target.dataset.node));
    }
  });
  svg.addEventListener('pointercancel', () => {
    origin = null;
  });
  svg.addEventListener('keydown', (e) => {
    if (['Enter', ' '].includes(e.key) && e.target.dataset.node) {
      e.preventDefault();
      inspectMemoryNode(state, Number(e.target.dataset.node));
    }
  });
  svg.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      state.scale = Math.max(0.5, Math.min(4, state.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
      memoryTransform(state);
    },
    { passive: false }
  );
  memoryTransform(state);
}

async function inspectMemoryNode(state, id) {
  const ticket = ++state.detailTicket;
  state.selected = id;
  drawMemory(state);
  const panel = state.el.querySelector('aside');
  panel.hidden = false;
  panel.textContent = 'Cargando recuerdo…';
  try {
    const detail = await ipcRenderer.invoke('memory-inspect', { nodeId: id });
    if (ticket !== state.detailTicket || !state.el.isConnected) return;
    if (!detail?.ok) throw new Error('not_found');
    const n = detail.node,
      meta = n.metamemory || {},
      evidence = detail.evidence || [];
    const confirmed = detail.history?.transitions?.some(
      (v) => v.currentNodeId === n.id && v.source === 'memory_control_ui'
    );
    const certainty = meta.stale
      ? 'Posiblemente desactualizado'
      : n.inferred
        ? 'Inferido por Kaoru'
        : confirmed
          ? 'Confirmado por ti'
          : evidence.length
            ? 'Respaldado por evidencias'
            : 'Registrado sin fuente verificable';
    const related = (state.adj.get(id) || []).slice(0, 40);
    const pinned = (n.tags || []).includes('memory:pinned');
    panel.innerHTML = `<button data-action="close-detail" aria-label="Cerrar detalle">×</button><h3>${memoryText(n.label)}</h3><p>${NODE_SYMBOLS[n.type] || '●'} ${memoryText(n.type)} · ${memoryText(certainty)}</p>
      <dl><dt>Confianza</dt><dd>${n.confidence == null ? 'No registrada' : Number(n.confidence).toFixed(2)}</dd><dt>Creado</dt><dd>${memoryDate(n.createdAt)}</dd><dt>Último uso registrado</dt><dd>${memoryDate(n.lastAccessedAt)}</dd><dt>Actualizado</dt><dd>${memoryDate(n.updatedAt)}</dd></dl>
      <h4>Contenido</h4><p class="memory-detail-text">${memoryText(n.content)}</p><textarea aria-label="Editar contenido" maxlength="12000" hidden>${memoryText(n.content)}</textarea>
      <div class="nodes-detail-actions"><button data-edit>Editar</button><button data-save hidden>Guardar</button><button data-pin>${pinned ? 'Desfijar' : 'Fijar'}</button><button data-delete>Olvidar</button></div>
      <p class="memory-detail-result" role="status"></p><h4>Relacionado con</h4>${related.length ? related.map((r) => `<button data-node="${r.id}">${memoryText(state.byId.get(r.id)?.label || r.id)} · ${memoryText(r.edge.type)}</button>`).join('') : 'Sin relaciones registradas.'}
      <h4>¿Por qué Kaoru sabe esto?</h4>${evidence.length ? evidence.map((e) => `<blockquote>${memoryText(e.content)}<footer>${memoryText(e.source)} · ${memoryDate(e.occurredAt)}</footer></blockquote>`).join('') : 'No hay una cita de origen guardada; la fecha de creación no identifica una conversación.'}
      <details><summary>Historial de cambios</summary>${(detail.history?.versions || []).map((v) => `<p>v${memoryText(v.version)} · ${memoryText(v.status)}<br>${memoryText(v.content)}</p>`).join('') || 'Sin versiones anteriores.'}</details>`;
    panel.querySelector('[data-edit]').onclick = () => {
      panel.querySelector('textarea').hidden = false;
      panel.querySelector('[data-save]').hidden = false;
      panel.querySelector('textarea').focus();
    };
    const mutate = async (channel, payload) => {
      panel.querySelectorAll('.nodes-detail-actions button').forEach((b) => (b.disabled = true));
      try {
        const r = await ipcRenderer.invoke(channel, {
          nodeId: id,
          expectedUpdatedAt: n.updatedAt,
          ...payload,
        });
        if (r.ok) {
          const fullscreen = state.el.classList.contains('memory-fullscreen');
          await renderGraph();
          if (fullscreen) memoryExplorer.el.classList.add('memory-fullscreen');
          if (channel !== 'memory-delete') await inspectMemoryNode(memoryExplorer, id);
        } else if (!r.cancelled)
          panel.querySelector('.memory-detail-result').textContent =
            r.error === 'memory_changed'
              ? 'Este recuerdo cambió. Ciérralo y vuelve a abrirlo antes de editar.'
              : 'No se pudo guardar el cambio.';
      } catch {
        panel.querySelector('.memory-detail-result').textContent = 'No se pudo guardar el cambio.';
      } finally {
        panel.querySelectorAll('.nodes-detail-actions button').forEach((b) => (b.disabled = false));
      }
    };
    panel.querySelector('[data-save]').onclick = () =>
      mutate('memory-correct', { content: panel.querySelector('textarea').value.trim() });
    panel.querySelector('[data-delete]').onclick = () => mutate('memory-delete', {});
    panel.querySelector('[data-pin]').onclick = () => mutate('memory-pin', { pinned: !pinned });
  } catch {
    if (ticket === state.detailTicket)
      panel.textContent = 'No se pudo cargar este recuerdo. Vuelve a seleccionarlo.';
  }
}

function renderMemoryGaps(state) {
  const target = state.el.querySelector('.memory-gaps > div');
  const prefs = state.data.gapPreferences || [];
  const rows = [
    ...(state.data.gaps || []),
    ...prefs
      .filter((p) => p.mode === 'never' || p.untilAt > Date.now())
      .map((p) => ({ key: p.key, trait: p.key.replaceAll('_', ' '), preference: p })),
  ];
  target.innerHTML = rows.length
    ? rows
        .map(
          (g) =>
            `<div class="memory-gap"><span>○ ${memoryText(g.trait)}${g.preference ? ` · ${g.preference.mode === 'never' ? 'No preguntar' : 'Pospuesto 7 días'}` : ''}</span>${g.preference ? `<button data-gap="${memoryText(g.key)}" data-mode="ask">Permitir preguntas</button>` : `<button data-gap="${memoryText(g.key)}" data-mode="never">No quiero que preguntes esto</button><button data-gap="${memoryText(g.key)}" data-mode="later">Pregúntame después</button>`}</div>`
        )
        .join('')
    : 'Sin huecos pendientes.';
  target.querySelectorAll('[data-gap]').forEach(
    (button) =>
      (button.onclick = async () => {
        button.disabled = true;
        try {
          const r = await ipcRenderer.invoke('memory-gap-preference', {
            key: button.dataset.gap,
            mode: button.dataset.mode,
          });
          if (r.ok) await renderGraph();
          else state.status('No se pudo guardar la preferencia.');
        } catch {
          state.status('No se pudo guardar la preferencia.');
        } finally {
          button.disabled = false;
        }
      })
  );
}

function attachMemoryContext(bubble, ids) {
  const unique = [...new Set((ids || []).filter(Number.isSafeInteger))];
  if (!unique.length || !bubble) return;
  const button = document.createElement('button');
  button.className = 'memory-context-link';
  button.textContent = `Memorias preparadas para esta respuesta: ${unique.length}`;
  button.title =
    'Recuerdos del contexto inicial. El agente puede recortarlos o recuperar otros; no prueba que cada uno influyera en la respuesta.';
  button.onclick = () => openNodes({ ids: unique });
  bubble.parentElement.appendChild(button);
}
