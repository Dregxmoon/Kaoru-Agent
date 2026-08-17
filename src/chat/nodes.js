// @ts-nocheck
// Grafo de memoria — vista inline en el chat de los nodos (Episode/Belief/
// Preference/Project/User) y sus conexiones implícitas. Se apoya en el IPC
// 'nodes-graph' (ipc/memory-handlers.js). Abre con el comando /memoria.
// Tiene botón de minimizar (SVG) y se oculta solo al enviar un mensaje.
// NOTA: messagesEl ya está declarado en messages.js (global compartido).

const NODE_COLORS = {
  Episode: '#5b8ff9',
  Belief: '#9254de',
  Preference: '#f759ab',
  Project: '#36cfc9',
  User: '#ffc53d',
};
const EDGE_COLORS = {
  consolida: '#ef4444',
  conversacion: '#60a5fa',
  tema: '#34d399',
};

function _nodeColor(type) {
  return NODE_COLORS[type] || '#9ca3af';
}

function _edgeLabel(type) {
  if (type === 'consolida') return 'consolida';
  if (type === 'conversacion') return 'misma conversación';
  if (type === 'tema') return 'tema común';
  return type;
}

// Layout force-directed (Fruchterman-Reingold) como el automático de Obsidian:
// los nodos conectados quedan juntos y los grupos separados según sus enlaces.
// Determinista (semilla fija) para que no cambie entre re-renders.
function _forceLayout(nodes, edges) {
  const W = 900;
  const H = 700;
  const pos = new Map();

  let seed = 42;
  const rnd = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };

  // Posiciones iniciales: malla dispersa con ruido (evita solapamientos al arrancar)
  const cols = Math.ceil(Math.sqrt(nodes.length)) || 1;
  nodes.forEach((node, i) => {
    pos.set(node.id, {
      x: 60 + (i % cols) * 90 + rnd() * 60,
      y: 60 + Math.floor(i / cols) * 90 + rnd() * 60,
      dx: 0,
      dy: 0,
      r: 9 + Math.round(node.importance * 14),
    });
  });

  // Adyacencia para la atracción (aristas)
  const adj = new Map();
  nodes.forEach((n) => adj.set(n.id, new Set()));
  for (const e of edges) {
    if (adj.has(e.source) && adj.has(e.target) && e.source !== e.target) {
      adj.get(e.source).add(e.target);
      adj.get(e.target).add(e.source);
    }
  }

  const area = W * H;
  const k = Math.sqrt(area / Math.max(nodes.length, 1));
  let temperature = W / 10;

  for (let iter = 0; iter < 300; iter++) {
    // Repulsión (todas las parejas) — Coulomb k²/dist
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      const pa = pos.get(a.id);
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const pb = pos.get(b.id);
        let dx = pa.x - pb.x;
        let dy = pa.y - pb.y;
        let dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 1) dist = 1;
        const f = (k * k) / dist;
        pa.dx += (dx / dist) * f;
        pa.dy += (dy / dist) * f;
        pb.dx -= (dx / dist) * f;
        pb.dy -= (dy / dist) * f;
      }
    }
    // Atracción (muelle) — Hooke dist²/k
    for (const [s, targets] of adj) {
      const pa = pos.get(s);
      for (const t of targets) {
        const pb = pos.get(t);
        if (pa === pb) continue;
        let dx = pb.x - pa.x;
        let dy = pb.y - pa.y;
        let dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 1) dist = 1;
        const f = (dist * dist) / k;
        pa.dx += (dx / dist) * f;
        pa.dy += (dy / dist) * f;
        pb.dx -= (dx / dist) * f;
        pb.dy -= (dy / dist) * f;
      }
    }
    // Aplicar desplazamiento limitado por temperatura
    for (const node of nodes) {
      const p = pos.get(node.id);
      const m = Math.hypot(p.dx, p.dy);
      if (m > 0) {
        const scale = Math.min(m, temperature) / m;
        p.x += p.dx * scale;
        p.y += p.dy * scale;
      }
      p.dx = 0;
      p.dy = 0;
    }
    temperature *= 0.97;
  }

  // Normalizar al centro con escala (fit-to-screen, como Obsidian)
  const pts = Array.from(pos.values());
  const minX = Math.min(...pts.map((p) => p.x));
  const maxX = Math.max(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y));
  const maxY = Math.max(...pts.map((p) => p.y));
  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);
  const scale = Math.min((W - 140) / spanX, (H - 140) / spanY, 2);
  const offX = (W - spanX * scale) / 2 - minX * scale;
  const offY = (H - spanY * scale) / 2 - minY * scale;
  for (const p of pts) {
    p.x = p.x * scale + offX;
    p.y = p.y * scale + offY;
  }

  // Desenredo final: empuja los nodos que se solapan hasta que no se pisen
  for (let pass = 0; pass < 40; pass++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) {
      const a = pos.get(nodes[i].id);
      for (let j = i + 1; j < nodes.length; j++) {
        const b = pos.get(nodes[j].id);
        const minDist = a.r + b.r + 6;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let dist = Math.hypot(dx, dy);
        if (dist >= minDist) continue;
        if (dist < 0.1) {
          dx = 1;
          dy = 0;
          dist = 1;
        }
        const push = (minDist - dist) / 2;
        const ux = dx / dist;
        const uy = dy / dist;
        a.x += ux * push;
        a.y += uy * push;
        b.x -= ux * push;
        b.y -= uy * push;
        moved = true;
      }
    }
    if (!moved) break;
  }

  return pos;
}

function _fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function openNodes() {
  renderGraph();
}

function hideNodes() {
  const inline = document.getElementById('nodes-inline');
  if (!inline || inline.hidden) return;
  // Minimizar: deja el header visible con el botón de maximizar para volver a
  // abrir el grafo, sin que desaparezca del chat.
  const body = inline.querySelector('.nodes-inline-body');
  const legend = inline.querySelector('.nodes-inline-legend');
  const hideBtn = inline.querySelector('.nodes-inline-hide');
  const maxBtn = inline.querySelector('.nodes-inline-max');
  if (body) body.style.display = 'none';
  if (legend) legend.style.display = 'none';
  const gapsEl = inline.querySelector('#nodes-inline-gaps');
  if (gapsEl) gapsEl.style.display = 'none';
  if (hideBtn) hideBtn.style.display = 'none';
  if (maxBtn) maxBtn.style.display = '';
}

function _renderLegend(edges) {
  const legend = document.getElementById('nodes-inline-legend');
  if (!legend) return;
  const edgeTypes = Array.from(new Set(edges.map((e) => e.type))).sort();
  legend.innerHTML =
    Object.keys(NODE_COLORS)
      .map(
        (t) =>
          `<span class="nodes-legend-item"><span class="nodes-legend-swatch" style="background:${_nodeColor(t)}"></span>${t}</span>`
      )
      .join('') +
    edgeTypes
      .map(
        (t) =>
          `<span class="nodes-legend-item"><span class="nodes-legend-line" style="border-color:${EDGE_COLORS[t] || '#888'}"></span>${_edgeLabel(t)}</span>`
      )
      .join('');
}

async function renderGraph() {
  let nodes = [];
  let edges = [];
  let gaps = [];
  try {
    const res = await ipcRenderer.invoke('nodes-graph', { limit: 120 });
    nodes = res.nodes || [];
    edges = res.edges || [];
    gaps = res.gaps || [];
  } catch (e) {
    console.error('[nodes] error grafo:', e.message || e);
  }

  // Re-render limpio: elimina grafo y tooltip previos si existen
  document.getElementById('nodes-inline')?.remove();
  document.getElementById('nodes-inline-tip')?.remove();

  const inline = document.createElement('div');
  inline.id = 'nodes-inline';
  inline.className = 'nodes-inline';
  inline.innerHTML = `
    <div class="nodes-inline-head">
      <span class="nodes-inline-title">Memoria — conexiones de nodos</span>
      <span class="nodes-inline-tools">
        <button class="nodes-inline-zoomin" title="Acercar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12">
            <circle cx="11" cy="11" r="7"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            <line x1="8" y1="11" x2="14" y2="11"></line>
            <line x1="11" y1="8" x2="11" y2="14"></line>
          </svg>
        </button>
        <button class="nodes-inline-zoomout" title="Alejar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12">
            <circle cx="11" cy="11" r="7"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            <line x1="8" y1="11" x2="14" y2="11"></line>
          </svg>
        </button>
        <button class="nodes-inline-hide" title="Minimizar grafo">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12">
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <button class="nodes-inline-max" title="Maximizar grafo" style="display: none">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12">
            <polyline points="15 3 21 3 21 9"></polyline>
            <polyline points="9 21 3 21 3 15"></polyline>
            <line x1="21" y1="3" x2="14" y2="10"></line>
            <line x1="3" y1="21" x2="10" y2="14"></line>
          </svg>
        </button>
      </span>
    </div>
    <div class="nodes-inline-body"></div>
    <div class="nodes-inline-legend" id="nodes-inline-legend"></div>
    <div class="nodes-inline-gaps" id="nodes-inline-gaps"></div>
  `;
  messagesEl.appendChild(inline);
  _scrollMessagesToBottom();

  function setMinimized(min) {
    inline.querySelector('.nodes-inline-body').style.display = min ? 'none' : '';
    const legend = inline.querySelector('.nodes-inline-legend');
    if (legend) legend.style.display = min ? 'none' : '';
    const gapsEl = inline.querySelector('#nodes-inline-gaps');
    if (gapsEl) gapsEl.style.display = min ? 'none' : '';
    inline.querySelector('.nodes-inline-hide').style.display = min ? 'none' : '';
    inline.querySelector('.nodes-inline-max').style.display = min ? '' : 'none';
  }
  inline.querySelector('.nodes-inline-hide').addEventListener('click', () => setMinimized(true));
  inline.querySelector('.nodes-inline-max').addEventListener('click', () => setMinimized(false));

  const body = inline.querySelector('.nodes-inline-body');
  if (nodes.length === 0) {
    body.innerHTML =
      '<div class="nodes-inline-empty">Aún no hay nodos que conectar. ¡Charla con el asistente!</div>';
    return;
  }
  _renderLegend(edges);

  // Gaps de conocimiento: rasgos del usuario que Kaoru aún no sabe. También
  // se inyectan al motor proactivo (message-gen.js) para preguntar con
  // curiosidad genuina.
  const gapsEl = inline.querySelector('#nodes-inline-gaps');
  if (gapsEl) {
    if (gaps.length) {
      gapsEl.innerHTML = `<span class="nodes-gaps-label">Aún no sé:</span> ${gaps
        .map((g) => `<span class="nodes-gap-item">${escapeHtml(g.trait)}</span>`)
        .join('')}`;
    } else {
      gapsEl.innerHTML = '<span class="nodes-gaps-ok">Sin gaps pendientes</span>';
    }
  }

  // Layout force-directed (agrupado por conexiones, como Obsidian) — ya
  // normalizado a 900×700 con margen interno.
  const positions = _forceLayout(nodes, edges);
  const parts = [
    `<svg id="nodes-svg" viewBox="0 0 900 700" role="img" aria-label="Conexiones entre nodos de memoria">`,
    `<g id="nodes-viewport">`,
  ];

  for (const e of edges) {
    const a = positions.get(e.source);
    const b = positions.get(e.target);
    if (!a || !b) continue;
    const color = EDGE_COLORS[e.type] || '#666';
    parts.push(
      `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${color}" stroke-width="1.2" stroke-opacity="0.45" data-source="${e.source}" data-target="${e.target}" />`
    );
  }

  for (const n of nodes) {
    const p = positions.get(n.id);
    if (!p) continue;
    const tags = (n.tags || [])
      .slice(0, 3)
      .map((t) => `#${t}`)
      .join(' ');
    parts.push(
      `<circle cx="${p.x}" cy="${p.y}" r="${p.r}" fill="${_nodeColor(n.type)}" fill-opacity="0.85" stroke="#fff" stroke-width="1" data-id="${n.id}" data-label="${escapeHtml(String(n.label))}" data-content="${escapeHtml(String(n.content || ''))}" data-type="${n.type}" data-imp="${Number(n.importance).toFixed(2)}" data-tags="${escapeHtml(tags)}" data-created="${_fmtDate(n.createdAt)}" />`,
      `<text x="${p.x}" y="${p.y + p.r + 12}" text-anchor="middle" font-family="monospace" font-size="9" fill="#ddd" data-id="${n.id}">${escapeHtml(String(n.label).slice(0, 18))}</text>`
    );
  }

  parts.push('</g>', '</svg>');
  body.innerHTML = parts.join('');

  // ── Zoom (botones) + pan (arrastrar con clic) ─────────────────────────────
  const svg = body.querySelector('#nodes-svg');
  const viewport = body.querySelector('#nodes-viewport');
  const SCALE = { x: 900, y: 700 }; // viewBox del SVG
  const state = { scale: 1, tx: 0, ty: 0 };

  function applyTransform() {
    viewport.setAttribute('transform', `translate(${state.tx} ${state.ty}) scale(${state.scale})`);
  }

  function zoomAt(factor, cx, cy) {
    const ns = Math.min(Math.max(state.scale * factor, 0.25), 6);
    if (ns === state.scale) return;
    state.tx = cx - ((cx - state.tx) * ns) / state.scale;
    state.ty = cy - ((cy - state.ty) * ns) / state.scale;
    state.scale = ns;
    applyTransform();
  }

  inline.querySelector('.nodes-inline-zoomin').addEventListener('click', () => {
    zoomAt(1.35, SCALE.x / 2, SCALE.y / 2);
  });
  inline.querySelector('.nodes-inline-zoomout').addEventListener('click', () => {
    zoomAt(1 / 1.35, SCALE.x / 2, SCALE.y / 2);
  });

  // Pan: clic presionado + arrastre
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  svg.style.cursor = 'grab';
  svg.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return;
    dragging = true;
    lastX = ev.clientX;
    lastY = ev.clientY;
    svg.style.cursor = 'grabbing';
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * SCALE.x;
    const py = ((ev.clientY - rect.top) / rect.height) * SCALE.y;
    state._dragStart = { tx: state.tx, ty: state.ty, px, py };
  });
  window.addEventListener('mousemove', (ev) => {
    if (!dragging) return;
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * SCALE.x;
    const py = ((ev.clientY - rect.top) / rect.height) * SCALE.y;
    const s = state._dragStart;
    state.tx = s.tx + (px - s.px);
    state.ty = s.ty + (py - s.py);
    applyTransform();
  });
  window.addEventListener('mouseup', () => {
    dragging = false;
    svg.style.cursor = 'grab';
  });

  const tip = document.createElement('div');
  tip.id = 'nodes-inline-tip';
  tip.style.cssText =
    'position:fixed;pointer-events:none;z-index:990;background:rgba(0,0,0,.9);color:#eee;font-family:monospace;font-size:10px;padding:6px 8px;border-radius:4px;max-width:300px;white-space:normal;display:none;';
  document.body.appendChild(tip);

  body.querySelectorAll('circle').forEach((c) => {
    c.addEventListener('mouseenter', (ev) => {
      tip.textContent = `[${c.dataset.type}] ${c.dataset.label} — imp. ${c.dataset.imp}${c.dataset.tags ? ' · ' + c.dataset.tags : ''}\n${_fmtDate(c.dataset.created)}\n${c.dataset.content}`;
      tip.style.display = 'block';
      tip.style.left = Math.min(ev.clientX + 12, window.innerWidth - 320) + 'px';
      tip.style.top = Math.min(ev.clientY + 12, window.innerHeight - 80) + 'px';
    });
    c.addEventListener('mousemove', (ev) => {
      tip.style.left = Math.min(ev.clientX + 12, window.innerWidth - 320) + 'px';
      tip.style.top = Math.min(ev.clientY + 12, window.innerHeight - 80) + 'px';
    });
    c.addEventListener('mouseleave', () => {
      tip.style.display = 'none';
    });
  });
}
