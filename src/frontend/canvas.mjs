// Interactive SVG grid canvas. Renders a model, snaps node drags to the integer
// grid, and lets the user select/add/delete nodes and edges. Emits changes via
// callbacks; it never owns the model — app.mjs does. Uses an SVG viewBox +
// getScreenCTM so hit-testing is correct at any display scale.

import { tex2disp, xcolorToHex, FLOW, UPRIGHT_STYLES, autoHalfWidth } from '/engine/svg.mjs';
import { formatSwigLabel } from '/engine/swig.mjs';

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

  let model = null, style = 'informal', swigStyle = 'superscript', view = null;
  let selection = [];        // set of { type:'node', id } | { type:'edge', index }
  let mode = 'select';       // 'select' | 'addEdge'
  let edgeFrom = null;       // pending source in addEdge mode
  let drag = null, edgeDrag = null, band = null;   // band = rubber-band select rect (px)
  let zoom = 1, pan = { x: 0, y: 0 }, panning = null;   // view transform (zoom + drag-to-pan)
  const capture = (el, id) => { try { el.setPointerCapture(id); } catch { /* no active pointer */ } };
  const isNodeSel = (id) => selection.some((s) => s.type === 'node' && s.id === id);
  const isEdgeSel = (i) => selection.some((s) => s.type === 'edge' && s.index === i);
  const toggleSel = (item) => {
    const i = selection.findIndex((s) => s.type === item.type && (item.type === 'node' ? s.id === item.id : s.index === item.index));
    if (i >= 0) selection.splice(i, 1); else selection.push(item);
  };

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
    let v;
    if (FLOW[node.style]) {
      v = { ...FLOW[node.style] };
    } else if (style === 'manuscript') {
      switch (node.style) {
        case 'cond': v = { shape: 'rect', fill: '#fff', stroke: '#1a1c22', text: '#1a1c22', rx: 19, ry: 17 }; break;
        case 'unobs': v = { shape: 'none', text: '#8a8f98', rx: 15, ry: 15 }; break;
        case 'regime': v = { shape: 'diamond', fill: '#fff', stroke: '#e07a1f', text: '#e07a1f', rx: 24, ry: 19 }; break;
        case 'fixed': v = { shape: 'none', text: '#e07a1f', rx: 15, ry: 15 }; break;
        default: v = { shape: 'none', text: '#1a1c22', rx: 15, ry: 15 };
      }
    } else if (node.style === 'cond') {
      v = { shape: 'rect', fill: '#fff', stroke: '#1a1c22', text: '#1a1c22', rx: 30, ry: 22, doubled: true };
    } else if (node.style === 'regime') {
      v = { shape: 'diamond', fill: '#fff', stroke: '#e07a1f', text: '#e07a1f', rx: 26, ry: 21 };
    } else if (node.style === 'fixed') {
      v = { shape: 'none', text: '#e07a1f', rx: 15, ry: 15 };
    } else {
      const key = node.role || (node.style === 'unobs' ? 'latent' : 'rv');
      const c = INFORMAL[key];
      v = c ? { shape: 'rrect', fill: c.fill, stroke: c.stroke, text: '#1a1c22', rx: 30, ry: 22, dashed: c.dashed }
            : { shape: 'rrect', fill: '#fff', stroke: '#c9ced6', text: '#1a1c22', rx: 30, ry: 22 };
    }
    // Per-node colour overrides (shared xcolor->hex mapper with the engine).
    if (node.fill || node.stroke) {
      if (v.shape === 'none') { v.shape = 'rrect'; v.rx = v.rx || 30; v.ry = v.ry || 22; v.fill = v.fill || '#fff'; }
      const f = xcolorToHex(node.fill); if (f) v.fill = f;
      const s = xcolorToHex(node.stroke); if (s) v.stroke = s;
    }
    const t = xcolorToHex(node.text); if (t) v.text = t;
    if (v.shape === 'rect' || v.shape === 'rrect' || v.shape === 'diamond') {
      v.rx = autoHalfWidth(node.label, v.rx);
    }
    return v;
  }

  function trim(px, py, ux, uy, v) {
    const rx = (v.rx || 15) + 2, ry = (v.ry || 15) + 2;
    const t = 1 / Math.sqrt((ux * ux) / (rx * rx) + (uy * uy) / (ry * ry) || 1);
    return [px + ux * t, py + uy * t];
  }

  function render() {
    if (!view) fit(model);
    const baseW = (view.maxx - view.minx) * CELL, baseH = (view.maxy - view.miny) * CELL;
    // zoom shrinks the viewBox (content scales up); pan offsets it. Centered.
    const vw = baseW / zoom, vh = baseH / zoom;
    const vx = baseW / 2 - vw / 2 + pan.x, vy = baseH / 2 - vh / 2 + pan.y;
    svg.setAttribute('viewBox', `${vx} ${vy} ${vw} ${vh}`);

    const pos = {};
    model.nodes.forEach((n) => (pos[n.id] = { x: gx2px(n.x), y: gy2px(n.y) }));
    const used = new Set(model.edges.map((e) => e.style));

    let s = `<defs>${[...used].map((st) => marker(st)).join('')}</defs>`;
    s += grid();
    model.edges.forEach((e, i) => { s += edgeSVG(e, i, pos); });
    model.nodes.forEach((n) => { s += nodeSVG(n, pos[n.id]); });
    s += (model.swig?.interventions || []).map((iv) => splitbarSVG(iv, pos)).join('');
    if (band) {
      const x = Math.min(band.x0, band.x1), y = Math.min(band.y0, band.y1);
      const w = Math.abs(band.x1 - band.x0), h = Math.abs(band.y1 - band.y0);
      s += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#2f6df6" fill-opacity="0.08" stroke="#2f6df6" stroke-width="1" stroke-dasharray="4 3" style="pointer-events:none"/>`;
    }
    svg.innerHTML = s;
    bind(pos);
    cbs.onStatus?.(mode, edgeFrom);
  }

  function grid() {
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
    let d, mid;
    if (e.bend) {
      const mx = (ax + bx) / 2, my = (ay + by) / 2, k = Math.tan((e.bend * Math.PI / 180) / 2);
      const cx = mx - uy * len * k * 0.5, cy = my + ux * len * k * 0.5;
      d = `M${ax},${ay} Q${cx},${cy} ${bx},${by}`;
      mid = { x: 0.25 * ax + 0.5 * cx + 0.25 * bx, y: 0.25 * ay + 0.5 * cy + 0.25 * by };
    } else { d = `M${ax},${ay} L${bx},${by}`; mid = { x: (ax + bx) / 2, y: (ay + by) / 2 }; }
    const sel = isEdgeSel(i);
    const start = e.style === 'bidirected' ? ` marker-start="url(#m-${e.style})"` : '';
    return `<g class="dg-edge" data-edge="${i}">`
      + `<path d="${d}" fill="none" stroke="transparent" stroke-width="12"/>`
      + `<path d="${d}" fill="none" stroke="${sel ? '#2f6df6' : color}" stroke-width="${sel ? 2.6 : 1.6}"${dash} marker-end="url(#m-${e.style})"${start}/>`
      + edgeLabelSVG(e, mid) + '</g>';
  }

  // Branch-condition label near the edge midpoint (mirrors svg.mjs renderEdgeLabel);
  // pointer-events off so it never steals edge clicks.
  function edgeLabelSVG(e, mid) {
    if (!e.label) return '';
    const pos = e.labelPos || 'above';
    let dx = 0, dy = -8, anchor = 'middle';
    if (/below/.test(pos)) dy = 15;
    if (/left/.test(pos)) { anchor = 'end'; dx = -7; if (!/above|below/.test(pos)) dy = 4; }
    else if (/right/.test(pos)) { anchor = 'start'; dx = 7; if (!/above|below/.test(pos)) dy = 4; }
    return `<text x="${mid.x + dx}" y="${mid.y + dy}" text-anchor="${anchor}" dominant-baseline="central" font-style="italic" font-size="14" fill="#3a3f47" paint-order="stroke" stroke="#fff" stroke-width="3" stroke-linejoin="round" style="pointer-events:none">${tex2disp(e.label)}</text>`;
  }

  function nodeSVG(n, p) {
    const v = nodeVisual(n);
    const sel = isNodeSel(n.id);
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
    // Flowchart boxes carry prose ("No antibiotics") → upright; DAG nodes carry
    // math vars ($A$) → italic. Mirrors svg.mjs renderNode.
    const fontStyle = UPRIGHT_STYLES.has(n.style) ? 'normal' : 'italic';
    const label = `<text x="${p.x}" y="${p.y}" text-anchor="middle" dominant-baseline="central" font-style="${fontStyle}" font-size="19" fill="${v.text}" style="pointer-events:none">${tex2disp(formatSwigLabel(n.label, swigStyle))}</text>`;
    return `<g class="dg-node" data-id="${n.id}">${shape}${hit}${label}</g>`;
  }

  function nodeById(id) { return model.nodes.find((n) => n.id === id) || { style: 'rv' }; }

  // Vertical orange bar centered between the rv node and its fixed-value node,
  // marking the SWIG split (mirrors src/engine/svg.mjs's renderSplitbar).
  function splitbarSVG(iv, pos) {
    const a = pos[iv.node], b = pos[iv.regimeLabel];
    if (!a || !b) return '';
    const x = (a.x + b.x) / 2;
    return `<line x1="${x}" y1="${a.y - 16}" x2="${x}" y2="${a.y + 16}" stroke="#e07a1f" stroke-width="2.2"/>`;
  }

  // ---- interaction ----
  function bind(pos) {
    svg.querySelectorAll('.dg-node').forEach((g) => {
      const id = g.getAttribute('data-id');
      g.addEventListener('pointerdown', (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        if (mode === 'addEdge') { handleEdgePick(id); return; }
        if (ev.shiftKey) { toggleSel({ type: 'node', id }); render(); cbs.onSelect?.(selection); return; }
        if (!isNodeSel(id)) selection = [{ type: 'node', id }];   // plain click on a new node → replace
        drag = { id, moved: false };
        capture(g, ev.pointerId);
        render(); cbs.onSelect?.(selection);
      });
    });
    svg.querySelectorAll('.dg-edge').forEach((g) => {
      g.addEventListener('pointerdown', (ev) => {
        if (mode === 'addEdge') return;
        ev.stopPropagation();
        const index = +g.getAttribute('data-edge');
        if (ev.shiftKey) { toggleSel({ type: 'edge', index }); render(); cbs.onSelect?.(selection); return; }
        if (!isEdgeSel(index)) selection = [{ type: 'edge', index }];
        edgeDrag = { index };                 // click = select; drag = arc
        capture(svg, ev.pointerId);
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
    if (band) { const u = clientToUser(ev.clientX, ev.clientY); band.x1 = u.x; band.y1 = u.y; render(); return; }
    if (drag) {
      const g = px2grid(ev.clientX, ev.clientY);
      const n = model.nodes.find((x) => x.id === drag.id);
      if (n && (n.x !== g.x || n.y !== g.y)) { n.x = g.x; n.y = g.y; drag.moved = true; render(); cbs.onChange?.(); }
      return;
    }
    if (edgeDrag) {
      const e = model.edges[edgeDrag.index];
      const na = model.nodes.find((n) => n.id === e.from), nb = model.nodes.find((n) => n.id === e.to);
      if (!na || !nb) return;
      const ax = gx2px(na.x), ay = gy2px(na.y), bx = gx2px(nb.x), by = gy2px(nb.y);
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
      const mx = (ax + bx) / 2, my = (ay + by) / 2;
      const pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
      const u = pt.matrixTransform(svg.getScreenCTM().inverse());
      const dperp = (u.x - mx) * (-uy) + (u.y - my) * ux;     // signed distance from chord
      let bend = Math.round(2 * Math.atan((4 * dperp) / len) * 180 / Math.PI);
      bend = Math.max(-80, Math.min(80, bend));
      if (bend !== e.bend) { e.bend = bend; render(); cbs.onChange?.(); }
      return;
    }
    if (panning) {
      pan.x = panning.px - (ev.clientX - panning.sx) / panning.a;
      pan.y = panning.py - (ev.clientY - panning.sy) / panning.d;
      render();
    }
  });
  const endGesture = () => {
    if (band) { commitBand(); band = null; render(); }
    drag = null; edgeDrag = null; if (panning) { panning = null; svg.style.cursor = ''; }
  };
  svg.addEventListener('pointerup', endGesture);
  svg.addEventListener('pointercancel', endGesture);
  // Empty-canvas press: shift-drag rubber-bands a selection (additive); a plain press
  // deselects, then drags to pan.
  svg.addEventListener('pointerdown', (ev) => {
    if (mode === 'addEdge') return;
    // Node/edge presses already preventDefault; the empty canvas needs it too, or the
    // browser starts a native text selection under the drag (shift-drag would band AND
    // highlight the page). Covers the pan press for the same reason.
    ev.preventDefault();
    if (ev.shiftKey) { const u = clientToUser(ev.clientX, ev.clientY); band = { x0: u.x, y0: u.y, x1: u.x, y1: u.y }; capture(svg, ev.pointerId); render(); return; }
    if (selection.length) { selection = []; cbs.onSelect?.(selection); }
    const ctm = svg.getScreenCTM();
    panning = { sx: ev.clientX, sy: ev.clientY, px: pan.x, py: pan.y, a: ctm.a, d: ctm.d };
    capture(svg, ev.pointerId);
    svg.style.cursor = 'grabbing';
    render();
  });
  // Rubber-band → add every node whose BOX INTERSECTS the band (grazing it is enough;
  // you shouldn't have to lasso a whole box to catch it) and every edge whose both ends
  // are caught. A too-small box is a no-op (it was just a mis-click).
  function commitBand() {
    const minx = Math.min(band.x0, band.x1), maxx = Math.max(band.x0, band.x1);
    const miny = Math.min(band.y0, band.y1), maxy = Math.max(band.y0, band.y1);
    if (maxx - minx < 4 && maxy - miny < 4) return;
    // nodeVisual applies autoHalfWidth, so rx/ry are the true rendered half-extents.
    const box = {};
    model.nodes.forEach((n) => { const v = nodeVisual(n); box[n.id] = { x: gx2px(n.x), y: gy2px(n.y), rx: v.rx, ry: v.ry }; });
    const hits = (id) => { const b = box[id]; return b && b.x + b.rx >= minx && b.x - b.rx <= maxx && b.y + b.ry >= miny && b.y - b.ry <= maxy; };
    model.nodes.forEach((n) => { if (hits(n.id) && !isNodeSel(n.id)) selection.push({ type: 'node', id: n.id }); });
    model.edges.forEach((e, i) => { if (hits(e.from) && hits(e.to) && !isEdgeSel(i)) selection.push({ type: 'edge', index: i }); });
    cbs.onSelect?.(selection);
  }
  function clientToUser(clientX, clientY) {
    const pt = svg.createSVGPoint(); pt.x = clientX; pt.y = clientY;
    const u = pt.matrixTransform(svg.getScreenCTM().inverse());
    return { x: u.x, y: u.y };
  }
  // Wheel to zoom (centered).
  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    setZoom(zoom * (ev.deltaY < 0 ? 1.12 : 1 / 1.12));
  }, { passive: false });

  function setZoom(z) { zoom = Math.min(6, Math.max(0.25, z)); render(); cbs.onZoom?.(zoom); }

  // ---- point-at (resolve the selection set to durable grammar handles) ----
  // The canvas owns its grammar, so each id IS the handle — no DOM/identity
  // reconstruction needed. Returns { handles: [{handle,label,style}], png } (one crop
  // of the union bbox of every selected element), or null when nothing is selected.
  function itemDescriptor(sel) {
    if (sel.type === 'node') {
      const n = model.nodes.find((x) => x.id === sel.id); if (!n) return null;
      return { handle: `@node:${n.id}`, label: n.label || '', style: n.style || '', el: svg.querySelector(`.dg-node[data-id="${cssEscape(n.id)}"]`) };
    }
    const e = model.edges[sel.index]; if (!e) return null;
    return { handle: `@edge:${e.from}->${e.to}`, label: e.label || '', style: e.style || '', el: svg.querySelector(`.dg-edge[data-edge="${sel.index}"]`) };
  }
  async function pointAt() {
    if (!selection.length) return null;
    const items = selection.map(itemDescriptor).filter(Boolean);
    if (!items.length) return null;
    const png = await elementsCrop(items.map((i) => i.el).filter(Boolean));
    return { handles: items.map(({ handle, label, style }) => ({ handle, label, style })), png };
  }

  // PNG crop of one or more rendered elements: the union of their bboxes + padding,
  // rasterized off a clone of the live SVG (so markers/labels/grid come along).
  // Best-effort — a failure returns null and the caller still emits the text handles.
  async function elementsCrop(els) {
    try {
      if (!els.length) return null;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      els.forEach((el) => { const b = el.getBBox(); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height); });
      const pad = 26, scale = 2;
      const x = x0 - pad, y = y0 - pad, w = (x1 - x0) + pad * 2, h = (y1 - y0) + pad * 2;
      const clone = svg.cloneNode(true);
      clone.removeAttribute('class');
      clone.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
      clone.setAttribute('width', w * scale); clone.setAttribute('height', h * scale);
      clone.innerHTML = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#ffffff"/>` + clone.innerHTML;
      const str = new XMLSerializer().serializeToString(clone);
      const blob = new Blob([str], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      try {
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
        const c = document.createElement('canvas'); c.width = w * scale; c.height = h * scale;
        c.getContext('2d').drawImage(img, 0, 0, w * scale, h * scale);
        return c.toDataURL('image/png');
      } finally { URL.revokeObjectURL(url); }
    } catch { return null; }
  }
  const cssEscape = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');

  // ---- public API ----
  return {
    setModel(m, { refit = true } = {}) { model = m; if (refit) { fit(m); zoom = 1; pan = { x: 0, y: 0 }; } render(); },
    setStyle(s) { style = s; render(); },
    setSwigStyle(s) { swigStyle = s; render(); },
    setMode(m) { mode = m; edgeFrom = null; render(); cbs.onModeChange?.(mode); },
    getMode() { return mode; },
    refit() { fit(model); zoom = 1; pan = { x: 0, y: 0 }; render(); cbs.onZoom?.(zoom); },
    zoomIn() { setZoom(zoom * 1.25); },
    zoomOut() { setZoom(zoom / 1.25); },
    getZoom() { return zoom; },
    rerender() { render(); },
    pointAt,
    getSelection() { return selection; },
    selectNode(id) { if (model.nodes.some((n) => n.id === id)) { selection = [{ type: 'node', id }]; render(); cbs.onSelect?.(selection); } },
    clearSelection() { selection = []; render(); cbs.onSelect?.(selection); },
    deleteSelection() {
      if (!selection.length) return;
      const nodeIds = new Set(selection.filter((s) => s.type === 'node').map((s) => s.id));
      // Resolve selected edges to identities before mutating (indices shift on delete).
      const edgeKeys = new Set(selection.filter((s) => s.type === 'edge').map((s) => model.edges[s.index]).filter(Boolean).map((e) => `${e.from}->${e.to}:${e.style}`));
      model.nodes = model.nodes.filter((n) => !nodeIds.has(n.id));
      model.edges = model.edges.filter((e) => !nodeIds.has(e.from) && !nodeIds.has(e.to) && !edgeKeys.has(`${e.from}->${e.to}:${e.style}`));
      selection = []; render(); cbs.onChange?.(); cbs.onSelect?.(selection);
    },
  };
}
