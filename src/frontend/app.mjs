// dag-generator app orchestrator. Exposes mount({ stage }) as a self-managing
// module so the SAME code runs standalone (index.html) and, later, as an
// analysis-room tab (window.DagGenerator.mount({ stage, ... })). All engine work
// is client-side; only LaTeX compile hits the server.

import * as formula from '/engine/formula.mjs';
import * as dagitty from '/engine/dagitty.mjs';
import * as tikz from '/engine/tikz.mjs';
import { layout } from '/engine/layout.mjs';
import { toSVG } from '/engine/svg.mjs';
import { toHTML } from '/engine/html.mjs';
import { intervene } from '/engine/swig.mjs';
import { NODE_STYLES, EDGE_STYLES, ROLES } from '/engine/model.mjs';
import { createCanvas } from '/canvas.mjs';

const START = 'exposure: A\noutcome: Y\nconfounder: L\nunmeasured: U\nY ~ A + L + U\nA ~ L + U';

export function mount({ stage }) {
  stage.innerHTML = TEMPLATE;
  const $ = (sel) => stage.querySelector(sel);
  let model = layout(formula.parse(START).model);
  let renderStyle = 'informal';

  const canvas = createCanvas($('.dg-canvas-host'), {
    onChange: () => { regenPanels(); status('ok'); },
    onSelect: (sel) => renderInspector(sel),
    onModeChange: (m) => { $('[data-act=addEdge]').classList.toggle('on', m === 'addEdge'); },
    onStatus: (m, from) => {
      $('.dg-hint').textContent = m === 'addEdge'
        ? (from ? `click the target node (source: ${from})` : 'click the source node')
        : '';
    },
  });
  canvas.setModel(model);

  // ---- code panels (Formula | TikZ | Dagitty) ----
  const panels = {
    formula: { el: $('#p-formula'), emit: () => formula.emit(model), parse: (t) => { const r = formula.parse(t); layout(r.model); return { model: r.model, flags: r.flags, refit: true }; } },
    tikz: { el: $('#p-tikz'), emit: () => tikz.emit(model, { wrap: 'picture' }), parse: (t) => { const r = tikz.parse(t); const noCoords = r.model.nodes.every((n) => n.x === 0 && n.y === 0); if (noCoords) layout(r.model); return { model: r.model, flags: r.flags, refit: noCoords }; } },
    dagitty: { el: $('#p-dagitty'), emit: () => dagitty.emit(model), parse: (t) => { const r = dagitty.parse(t); const noCoords = r.model.nodes.every((n) => n.x === 0 && n.y === 0); if (noCoords) layout(r.model); return { model: r.model, flags: r.flags, refit: true }; } },
  };
  let activePanel = 'formula';

  Object.entries(panels).forEach(([key, p]) => {
    p.el.addEventListener('input', debounce(() => {
      const { model: m, flags, refit } = p.parse(p.el.value);
      model = m; model.meta.style = renderStyle;
      canvas.setModel(model, { refit });
      regenPanels(key);
      status(flags.length ? 'warn' : 'ok', flags);
      renderInspector(canvas.getSelection());
    }, 240));
  });

  stage.querySelectorAll('.dg-tab').forEach((t) => t.addEventListener('click', () => {
    activePanel = t.dataset.panel;
    stage.querySelectorAll('.dg-tab').forEach((x) => x.setAttribute('aria-selected', x === t));
    Object.entries(panels).forEach(([k, p]) => p.el.classList.toggle('hidden', k !== activePanel));
  }));

  // ---- toolbar ----
  $('[data-act=style]').addEventListener('click', (e) => {
    renderStyle = renderStyle === 'informal' ? 'manuscript' : 'informal';
    model.meta.style = renderStyle;
    canvas.setStyle(renderStyle);
    e.target.textContent = renderStyle === 'informal' ? 'Style: Informal' : 'Style: Manuscript';
    regenPanels();
  });
  $('[data-act=addNode]').addEventListener('click', () => {
    const ids = new Set(model.nodes.map((n) => n.id));
    let i = 1, id; do { id = 'V' + i++; } while (ids.has(id));
    const maxx = model.nodes.length ? Math.max(...model.nodes.map((n) => n.x)) : 0;
    model.nodes.push({ id, label: `$${id}$`, x: maxx + 2, y: 0, style: 'rv' });
    canvas.setModel(model, { refit: true }); regenPanels(); status('ok');
  });
  $('[data-act=addEdge]').addEventListener('click', () => {
    canvas.setMode(canvas.getMode() === 'addEdge' ? 'select' : 'addEdge');
  });
  $('[data-act=del]').addEventListener('click', () => canvas.deleteSelection());
  $('[data-act=fit]').addEventListener('click', () => canvas.refit());
  $('[data-act=relayout]').addEventListener('click', () => { layout(model); canvas.setModel(model, { refit: true }); regenPanels(); });

  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && !isTyping(e)) { e.preventDefault(); canvas.deleteSelection(); }
    if (e.key === 'Escape') canvas.setMode('select');
  });

  // collapse the side panel
  $('[data-act=collapse]').addEventListener('click', () => {
    const collapsed = stage.querySelector('.dg-app').classList.toggle('side-collapsed');
    $('[data-act=collapse]').textContent = collapsed ? '‹' : '›';
    setTimeout(() => canvas.refit(), 260);
  });

  // ---- export menu ----
  stage.querySelectorAll('[data-export]').forEach((b) => b.addEventListener('click', () => doExport(b.dataset.export)));

  function doExport(fmt) {
    model.meta.style = renderStyle;
    const base = (model.meta.title || 'dag').replace(/\W+/g, '-').toLowerCase() || 'dag';
    if (fmt === 'json') return download(`${base}.json`, JSON.stringify(model, null, 2), 'application/json');
    if (fmt === 'formula') return download(`${base}.formula.txt`, formula.emit(model), 'text/plain');
    if (fmt === 'dagitty') return download(`${base}.dagitty.txt`, dagitty.emit(model), 'text/plain');
    if (fmt === 'tex') return download(`${base}.tex`, tikz.emit(model, { wrap: 'standalone' }), 'text/plain');
    if (fmt === 'svg') return download(`${base}.svg`, toSVG(model, { style: renderStyle }), 'image/svg+xml');
    if (fmt === 'html') return download(`${base}.html`, toHTML(model, { style: renderStyle }), 'text/html');
    if (['pdf', 'png', 'svg-tex'].includes(fmt)) return compileExport(fmt, base);
  }

  async function compileExport(fmt, base) {
    const format = fmt === 'svg-tex' ? 'svg' : fmt;
    status('compiling', null, 'compiling with LaTeX…');
    try {
      const res = await fetch('/dag/api/compile', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, format }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        status('warn', null, err.code === 'NO_LATEX' ? 'LaTeX not installed — use SVG/HTML export instead.' : `compile failed: ${err.error || res.status}`);
        return;
      }
      const blob = await res.blob();
      downloadBlob(`${base}.${format === 'svg' ? 'svg' : format}`, blob);
      status('ok', null, `compiled ${format.toUpperCase()} ✓`);
    } catch (e) { status('warn', null, `compile error: ${e.message}`); }
  }

  // ---- inspector ----
  function renderInspector(sel) {
    const box = $('.dg-inspector');
    if (!sel) { box.innerHTML = '<p class="dg-muted">Select a node or edge to edit it.</p>'; return; }
    if (sel.type === 'node') {
      const n = model.nodes.find((x) => x.id === sel.id); if (!n) { box.innerHTML = ''; return; }
      box.innerHTML = `
        <h4>Node</h4>
        ${field('id', `<input id="i-id" value="${esc(n.id)}">`)}
        ${field('label', `<input id="i-label" value="${esc(n.label)}">`)}
        ${field('style', select('i-style', NODE_STYLES, n.style))}
        ${field('role', select('i-role', ['(none)', ...ROLES], n.role || '(none)'))}
        <p class="dg-muted">pos (${n.x}, ${n.y})</p>
        <button class="dg-btn dg-swig-btn" id="i-intervene">⋔ Intervene → SWIG</button>`;
      $('#i-id').addEventListener('change', (e) => renameNode(n.id, e.target.value.trim()));
      $('#i-label').addEventListener('input', (e) => { n.label = e.target.value; canvas.rerender(); regenPanels(); });
      $('#i-style').addEventListener('change', (e) => { n.style = e.target.value; canvas.rerender(); regenPanels(); });
      $('#i-role').addEventListener('change', (e) => { const v = e.target.value; if (v === '(none)') delete n.role; else n.role = v; canvas.rerender(); regenPanels(); });
      $('#i-intervene').addEventListener('click', () => {
        model = intervene(model, n.id); model.meta.style = renderStyle;
        canvas.setModel(model, { refit: true }); canvas.clearSelection();
        regenPanels(); renderInspector(null); status('ok', null, 'SWIG: split treatment into regime node');
      });
    } else {
      const e = model.edges[sel.index]; if (!e) { box.innerHTML = ''; return; }
      box.innerHTML = `
        <h4>Edge <span class="dg-muted">${esc(e.from)} → ${esc(e.to)}</span></h4>
        ${field('style', select('e-style', EDGE_STYLES, e.style))}
        ${field('bend', `<input id="e-bend" type="number" step="5" value="${e.bend}"> <span class="dg-muted">+left / −right</span>`)}`;
      $('#e-style').addEventListener('change', (ev) => { e.style = ev.target.value; canvas.rerender(); regenPanels(); });
      $('#e-bend').addEventListener('input', (ev) => { e.bend = parseInt(ev.target.value, 10) || 0; canvas.rerender(); regenPanels(); });
    }
  }

  function renameNode(oldId, newId) {
    if (!newId || newId === oldId || model.nodes.some((n) => n.id === newId)) { canvas.rerender(); return; }
    model.nodes.forEach((n) => { if (n.id === oldId) n.id = newId; });
    model.edges.forEach((e) => { if (e.from === oldId) e.from = newId; if (e.to === oldId) e.to = newId; });
    if (model.swig) model.swig.interventions.forEach((iv) => { if (iv.node === oldId) iv.node = newId; });
    canvas.clearSelection(); canvas.rerender(); regenPanels();
  }

  // ---- helpers ----
  function regenPanels(except) {
    for (const [key, p] of Object.entries(panels)) {
      if (key === except) continue;               // don't clobber the panel being typed in
      if (document.activeElement === p.el) continue;
      p.el.value = p.emit();
    }
  }
  function status(kind, flags, msg) {
    const el = $('.dg-status');
    el.className = 'dg-status ' + (kind === 'warn' ? 'warn' : kind === 'compiling' ? 'busy' : 'ok');
    if (msg) { el.textContent = msg; return; }
    if (flags && flags.length) el.innerHTML = flags.map((f) => `line ${f.line}: ${esc(f.why)}`).join(' · ');
    else el.textContent = `${model.nodes.length} nodes · ${model.edges.length} edges`;
  }

  regenPanels(); renderInspector(null); status('ok');
  return { getModel: () => model };
}

// ---- small DOM utils ----
function field(label, control) { return `<label class="dg-field"><span>${label}</span>${control}</label>`; }
function select(id, opts, cur) { return `<select id="${id}">${opts.map((o) => `<option${o === cur ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`; }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function isTyping(e) { const t = e.target.tagName; return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT'; }
function debounce(fn, ms) { let id; return (...a) => { clearTimeout(id); id = setTimeout(() => fn(...a), ms); }; }
function download(name, text, type) { downloadBlob(name, new Blob([text], { type })); }
function downloadBlob(name, blob) { const u = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = u; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(u), 1500); }

const TEMPLATE = `
<div class="dg-app">
  <div class="dg-toolbar">
    <strong class="dg-brand">dag-generator</strong>
    <button class="dg-btn" data-act="style">Style: Informal</button>
    <span class="dg-sep"></span>
    <button class="dg-btn" data-act="addNode">+ node</button>
    <button class="dg-btn" data-act="addEdge">+ edge</button>
    <button class="dg-btn" data-act="del">delete</button>
    <button class="dg-btn" data-act="relayout">auto-layout</button>
    <button class="dg-btn" data-act="fit">fit</button>
    <span class="dg-sep"></span>
    <details class="dg-export">
      <summary class="dg-btn">export ▾</summary>
      <div class="dg-menu">
        <button data-export="tex">LaTeX (.tex)</button>
        <button data-export="pdf">PDF (compile)</button>
        <button data-export="svg-tex">SVG (compiled)</button>
        <button data-export="svg">SVG (engine)</button>
        <button data-export="png">PNG (compile)</button>
        <button data-export="html">HTML</button>
        <button data-export="dagitty">dagitty</button>
        <button data-export="formula">formula</button>
        <button data-export="json">JSON</button>
      </div>
    </details>
    <span class="dg-grow"></span>
    <button class="dg-btn dg-collapse" data-act="collapse" title="collapse panel">›</button>
  </div>
  <div class="dg-body">
    <div class="dg-canvas-wrap">
      <div class="dg-canvas-host"></div>
      <div class="dg-hint"></div>
    </div>
    <aside class="dg-side">
      <div class="dg-side-tabs" role="tablist">
        <button class="dg-tab" role="tab" data-panel="formula" aria-selected="true">Formula</button>
        <button class="dg-tab" role="tab" data-panel="tikz" aria-selected="false">TikZ</button>
        <button class="dg-tab" role="tab" data-panel="dagitty" aria-selected="false">Dagitty</button>
      </div>
      <div class="dg-panels">
        <textarea id="p-formula" class="dg-code" spellcheck="false"></textarea>
        <textarea id="p-tikz" class="dg-code hidden" spellcheck="false"></textarea>
        <textarea id="p-dagitty" class="dg-code hidden" spellcheck="false"></textarea>
      </div>
      <div class="dg-status ok"></div>
      <div class="dg-inspector"></div>
    </aside>
  </div>
</div>`;
