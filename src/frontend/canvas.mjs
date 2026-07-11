// Interactive SVG grid canvas. Renders a model, snaps node drags to the integer
// grid, and lets the user select/add/delete nodes and edges. Emits changes via
// callbacks; it never owns the model — app.mjs does. Uses an SVG viewBox +
// getScreenCTM so hit-testing is correct at any display scale.

import { tex2disp } from '/engine/svg.mjs';

const CELL = 74;
const MARGIN = 1.2;

const EDGE_COLOR = {
  causal: '#555555', det: '#555555', reads: '#e07a1f', cfedge: '#e07a1f',
  biasing: '#c0392b', blocked: '#888888', bidirected: '#8a8f98',
};
const INFORMAL = {
  exposure: { fill: '#dae8fc', stroke: '#6c8ebf' },
  outcome: { fill: '#fff2cc', stroke: '#d6b656' },
  confounder: { fill: '#d5e8d4', stroke: '#82b366' },
  covariate: { fill: '#d5e8d4', stroke: '#82b366' },
  collider: { fill: '#f8d7da', stroke: '#c0392b' },
  mediator: { fill: '#e1d5e7', stroke: '#9673a6' },
  latent: { fill: '#f0f0f0', stroke: '#999999', dashed: true },
};

export function createCanvas(host, cbs) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'dg-canvas');
  host.appendChild(svg);

  let model = null, style = 'informal', view = null;
  let selection = null;      // { type:'node'|'edge', id|index }
  let mode = 'select';       // 'select' | 'addEdge'
  let edgeFrom = null;       // pending source in addEdge mode
  let drag = null;

  function fit(m) {
    const ns = m.nodes;
    let minx = 0, maxx = 3, miny = 0, maxy = 2;
    if (ns.length) {
      minx = Math.min(...ns.map((n) => n.x)); maxx = Math.max(...ns.map((n) => n.x));
      miny = Math.min(...ns.map((n) => n.y)); maxy = Math.max(...ns.map((n) => n.y));
    }
    view = { minx: minx - MARGIN, maxx: maxx + MARGIN, miny: miny - MARGIN, maxy: maxy + MARGIN };
  }

  const gx2px = (x) => (x - view.minx) * CELL;
  const gy2px = (y) => (view.maxy - y) * CELL;
  function px2grid(clientX, clientY) {
    const pt = svg.createSVGPoint(); pt.x = clientX; pt.y = clientY;
    const u = pt.matrixTransform(svg.getScreenCTM().inverse());
    return { x: Math.round(u.x / CELL + view.minx), y: Math.round(view.maxy - u.y / CELL) };
  }

  function nodeVisual(node) {
    if (style === 'manuscript') {
      switch (node.style) {
        case 'cond': return { shape: 'rect', fill: '#fff', stroke: '#1a1c22', text: '#1a1c22', rx: 19, ry: 17 };
        case 'unobs': return { shape: 'none', text: '#8a8f98', rx: 15, ry: 15 };
        case 'regime': return { shape: 'diamond', fill: '#fff', stroke: '#e07a1f', text: '#e07a1f', rx: 24, ry: 19 };
        case 'fixed': return { shape: 'none', text: '#e07a1f', rx: 15, ry: 15 };
        default: return { shape: 'none', text: '#1a1c22', rx: 15, ry: 15 };
      }
    }
    if (node.style === 'cond') return { shape: 'rect', fill: '#fff', stroke: '#1a1c22', text: '#1a1c22', rx: 30, ry: 22, doubled: true };
    if (node.style === 'regime') return { shape: 'diamond', fill: '#fff', stroke: '#e07a1f', text: '#e07a1f', rx: 26, ry: 21 };
    if (node.style === 'fixed') return { shape: 'none', text: '#e07a1f', rx: 15, ry: 15 };
    const key = node.role || (node.style === 'unobs' ? 'latent' : 'rv');
    const c = INFORMAL[key];
    if (c) return { shape: 'rrect', fill: c.fill, stroke: c.stroke, text: '#1a1c22', rx: 30, ry: 22, dashed: c.dashed };
    return { shape: 'rrect', fill: '#fff', stroke: '#c9ced6', text: '#1a1c22', rx: 30, ry: 22 };
  }

  function trim(px, py, ux, uy, v) {
    const rx = (v.rx || 15) + 2, ry = (v.ry || 15) + 2;
    const t = 1 / Math.sqrt((ux * ux) / (rx * rx) + (uy * uy) / (ry * ry) || 1);
    return [px + ux * t, py + uy * t];
  }

  function render() {
    if (!view) fit(model);
    const w = (view.maxx - view.minx) * CELL, h = (view.maxy - view.miny) * CELL;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);

    const pos = {};
    model.nodes.forEach((n) => (pos[n.id] = { x: gx2px(n.x), y: gy2px(n.y) }));
    const used = new Set(model.edges.map((e) => e.style));

    let s = `<defs>${[...used].map((st) => marker(st)).join('')}</defs>`;
    s += grid(w, h);
    model.edges.forEach((e, i) => { s += edgeSVG(e, i, pos); });
    model.nodes.forEach((n) => { s += nodeSVG(n, pos[n.id]); });
    svg.innerHTML = s;
    bind(pos);
    cbs.onStatus?.(mode, edgeFrom);
  }

  function grid(w, h) {
    let dots = '';
    for (let gx = Math.ceil(view.minx); gx <= Math.floor(view.maxx); gx++)
      for (let gy = Math.ceil(view.miny); gy <= Math.floor(view.maxy); gy++)
        dots += `<circle cx="${gx2px(gx)}" cy="${gy2px(gy)}" r="1.1" fill="#d7dbe0"/>`;
    return dots;
  }

  function marker(st) {
    const c = EDGE_COLOR[st] || '#555';
    return `<marker id="m-${st}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${c}"/></marker>`;
  }

  function edgeSVG(e, i, pos) {
    const a = pos[e.from], b = pos[e.to];
    if (!a || !b) return '';
    const va = nodeVisual(nodeById(e.from)), vb = nodeVisual(nodeById(e.to));
    const color = EDGE_COLOR[e.style] || '#555';
    const dash = (e.style === 'reads' || e.style === 'blocked' || e.style === 'bidirected') ? ' stroke-dasharray="6 4"' : '';
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
    const [ax, ay] = trim(a.x, a.y, ux, uy, va);
    const [bx, by] = trim(b.x, b.y, -ux, -uy, vb);
    let d;
    if (e.bend) {
      const mx = (ax + bx) / 2, my = (ay + by) / 2, k = Math.tan((e.bend * Math.PI / 180) / 2);
      d = `M${ax},${ay} Q${mx - uy * len * k * 0.5},${my + ux * len * k * 0.5} ${bx},${by}`;
    } else d = `M${ax},${ay} L${bx},${by}`;
    const sel = selection && selection.type === 'edge' && selection.index === i;
    const start = e.style === 'bidirected' ? ` marker-start="url(#m-${e.style})"` : '';
    return `<g class="dg-edge" data-edge="${i}">`
      + `<path d="${d}" fill="none" stroke="transparent" stroke-width="12"/>`
      + `<path d="${d}" fill="none" stroke="${sel ? '#2f6df6' : color}" stroke-width="${sel ? 2.6 : 1.6}"${dash} marker-end="url(#m-${e.style})"${start}/></g>`;
  }

  function nodeSVG(n, p) {
    const v = nodeVisual(n);
    const sel = selection && selection.type === 'node' && selection.id === n.id;
    const pending = edgeFrom === n.id;
    let shape = '';
    const dash = v.dashed ? ' stroke-dasharray="5 4"' : '';
    const stroke = sel || pending ? '#2f6df6' : v.stroke;
    const sw = sel || pending ? 2.4 : 1.6;
    if (v.shape === 'rect' || v.shape === 'rrect') {
      const r = v.shape === 'rrect' ? 8 : 2;
      shape = `<rect x="${p.x - v.rx}" y="${p.y - v.ry}" width="${v.rx * 2}" height="${v.ry * 2}" rx="${r}" fill="${v.fill}" stroke="${stroke}" stroke-width="${sw}"${dash}/>`;
      if (v.doubled) shape += `<rect x="${p.x - v.rx + 3}" y="${p.y - v.ry + 3}" width="${v.rx * 2 - 6}" height="${v.ry * 2 - 6}" rx="${r}" fill="none" stroke="${v.stroke}" stroke-width="1"/>`;
    } else if (v.shape === 'diamond') {
      shape = `<polygon points="${p.x},${p.y - v.ry} ${p.x + v.rx},${p.y} ${p.x},${p.y + v.ry} ${p.x - v.rx},${p.y}" fill="${v.fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
    } else if (sel || pending) {
      shape = `<circle cx="${p.x}" cy="${p.y}" r="${v.rx}" fill="none" stroke="#2f6df6" stroke-width="1.5" stroke-dasharray="3 3"/>`;
    }
    const hit = `<circle cx="${p.x}" cy="${p.y}" r="${Math.max(v.rx, v.ry)}" fill="#fff" opacity="0"/>`;
    const label = `<text x="${p.x}" y="${p.y}" text-anchor="middle" dominant-baseline="central" font-style="italic" font-size="19" fill="${v.text}" style="pointer-events:none">${tex2disp(n.label)}</text>`;
    return `<g class="dg-node" data-id="${n.id}">${shape}${hit}${label}</g>`;
  }

  function nodeById(id) { return model.nodes.find((n) => n.id === id) || { style: 'rv' }; }

  // ---- interaction ----
  function bind(pos) {
    svg.querySelectorAll('.dg-node').forEach((g) => {
      const id = g.getAttribute('data-id');
      g.addEventListener('pointerdown', (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        if (mode === 'addEdge') { handleEdgePick(id); return; }
        selection = { type: 'node', id };
        drag = { id, moved: false };
        g.setPointerCapture(ev.pointerId);
        render(); cbs.onSelect?.(selection);
      });
    });
    svg.querySelectorAll('.dg-edge').forEach((g) => {
      g.addEventListener('pointerdown', (ev) => {
        if (mode === 'addEdge') return;
        ev.stopPropagation();
        selection = { type: 'edge', index: +g.getAttribute('data-edge') };
        render(); cbs.onSelect?.(selection);
      });
    });
  }

  function handleEdgePick(id) {
    if (!edgeFrom) { edgeFrom = id; render(); return; }
    if (edgeFrom !== id && !model.edges.some((e) => e.from === edgeFrom && e.to === id)) {
      model.edges.push({ from: edgeFrom, to: id, style: 'causal', bend: 0 });
      cbs.onChange?.();
    }
    edgeFrom = null; mode = 'select';
    render(); cbs.onModeChange?.(mode);
  }

  svg.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const g = px2grid(ev.clientX, ev.clientY);
    const n = model.nodes.find((x) => x.id === drag.id);
    if (n && (n.x !== g.x || n.y !== g.y)) { n.x = g.x; n.y = g.y; drag.moved = true; render(); cbs.onChange?.(); }
  });
  svg.addEventListener('pointerup', () => { drag = null; });
  svg.addEventListener('pointercancel', () => { drag = null; });
  svg.addEventListener('pointerdown', () => {
    if (mode === 'addEdge') return;
    if (selection) { selection = null; render(); cbs.onSelect?.(null); }
  });

  // ---- public API ----
  return {
    setModel(m, { refit = true } = {}) { model = m; if (refit) fit(m); render(); },
    setStyle(s) { style = s; render(); },
    setMode(m) { mode = m; edgeFrom = null; render(); cbs.onModeChange?.(mode); },
    getMode() { return mode; },
    refit() { fit(model); render(); },
    rerender() { render(); },
    getSelection() { return selection; },
    clearSelection() { selection = null; render(); cbs.onSelect?.(null); },
    deleteSelection() {
      if (!selection) return;
      if (selection.type === 'node') {
        model.nodes = model.nodes.filter((n) => n.id !== selection.id);
        model.edges = model.edges.filter((e) => e.from !== selection.id && e.to !== selection.id);
      } else {
        model.edges.splice(selection.index, 1);
      }
      selection = null; render(); cbs.onChange?.(); cbs.onSelect?.(null);
    },
  };
}
