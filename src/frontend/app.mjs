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
import { NODE_STYLES, EDGE_STYLES, ROLES, cloneModel } from '/engine/model.mjs';
import { createCanvas } from '/canvas.mjs';

// Default DAG loaded on a fresh open (Alec's paper DAG). Canonical TikZ so its
// coordinates are preserved verbatim.
const START = [
  '\\node[rv](A) at (1,-1) {$A$};',
  '\\node[rv](X) at (1,1) {$X$};',
  '\\node[rv](H0) at (3,-1) {$H0$};',
  '\\node[rv](V0) at (3,1) {$V0$};',
  '\\node[rv](H1) at (5,-1) {$H1$};',
  '\\node[rv](V1) at (5,1) {$V1$};',
  '\\node[rv](Hs) at (7,1) {$H^{*}$};',
  '\\draw[causal] (X) to (A);',
  '\\draw[causal] (A) to (H0);',
  '\\draw[causal] (X) to (H0);',
  '\\draw[causal] (H0) to (V0);',
  '\\draw[causal] (A) to (V0);',
  '\\draw[causal] (X) to (V0);',
  '\\draw[causal] (H0) to (H1);',
  '\\draw[causal] (H0) to (V1);',
  '\\draw[causal] (X) to (V1);',
  '\\draw[causal] (A) to (V1);',
  '\\draw[causal] (H1) to (Hs);',
  '\\draw[causal] (V1) to (Hs);',
  '\\draw[causal] (H1) to (V1);',
  '\\draw[causal] (V0) to (H1);',
].join('\n');

export function mount({ stage }) {
  stage.innerHTML = TEMPLATE;
  const $ = (sel) => stage.querySelector(sel);
  let model = tikz.parse(START).model;
  model.meta.style = 'informal';
  let renderStyle = 'informal';
  let swigStyle = 'superscript';
  let preLayout = null;  // snapshot for one-step "revert layout"
  let currentSlug = null, currentName = '';  // the open saved-config, if any
  let loading = false, autosaveTimer = null; // autosave-to-current-config state
  let undoStack = [], redoStack = [], lastSnapshot = JSON.stringify(model), lastRecordTime = 0;

  function showRevert(on) { const b = $('[data-act=revert]'); if (b) b.hidden = !on; }
  function invalidateRevert() { if (preLayout) { preLayout = null; showRevert(false); } }

  const canvas = createCanvas($('.dg-canvas-host'), {
    onChange: () => { regenPanels(); status('ok'); renderInspector(canvas.getSelection()); invalidateRevert(); },
    onSelect: (sel) => renderInspector(sel),
    onModeChange: (m) => { $('[data-act=addEdge]').classList.toggle('on', m === 'addEdge'); },
    onStatus: (m, from) => {
      $('.dg-hint').textContent = m === 'addEdge'
        ? (from ? `click the target node (source: ${from})` : 'click the source node')
        : '';
    },
    onZoom: (z) => { $('.dg-zoom-label').textContent = Math.round(z * 100) + '%'; },
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
      model = m; model.meta.style = renderStyle; model.meta.swigStyle = swigStyle;
      canvas.setModel(model, { refit });
      regenPanels(key);
      status(flags.length ? 'warn' : 'ok', flags);
      renderInspector(canvas.getSelection());
      invalidateRevert();
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
    regenPanels(); invalidateRevert();
  });
  $('[data-act=swigStyle]').addEventListener('click', (e) => {
    swigStyle = swigStyle === 'paren' ? 'superscript' : 'paren';
    model.meta.swigStyle = swigStyle;
    canvas.setSwigStyle(swigStyle);
    e.target.textContent = swigStyle === 'paren' ? 'SWIG: Y(a)' : 'SWIG: Yᵃ';
    regenPanels(); invalidateRevert();
  });
  $('[data-act=addNode]').addEventListener('click', () => {
    const ids = new Set(model.nodes.map((n) => n.id));
    let i = 1, id; do { id = 'V' + i++; } while (ids.has(id));
    const maxx = model.nodes.length ? Math.max(...model.nodes.map((n) => n.x)) : 0;
    model.nodes.push({ id, label: `$${id}$`, x: maxx + 2, y: 0, style: 'rv' });
    canvas.setModel(model, { refit: true }); regenPanels(); status('ok'); invalidateRevert();
  });
  $('[data-act=addEdge]').addEventListener('click', () => {
    canvas.setMode(canvas.getMode() === 'addEdge' ? 'select' : 'addEdge');
  });
  $('[data-act=del]').addEventListener('click', () => canvas.deleteSelection());
  $('[data-act=pointAt]').addEventListener('click', pointAt);
  $('[data-act=fit]').addEventListener('click', () => canvas.refit());
  $('[data-act=zoomIn]').addEventListener('click', () => canvas.zoomIn());
  $('[data-act=zoomOut]').addEventListener('click', () => canvas.zoomOut());
  $('.dg-zoom-label').addEventListener('click', () => canvas.refit());
  $('[data-act=relayout]').addEventListener('click', () => {
    preLayout = cloneModel(model);
    layout(model); canvas.setModel(model, { refit: true }); regenPanels();
    showRevert(true); status('ok', null, 'auto-laid out — “revert” to undo');
  });
  $('[data-act=revert]').addEventListener('click', () => {
    if (!preLayout) return;
    model = preLayout; preLayout = null; model.meta.style = renderStyle; model.meta.swigStyle = swigStyle;
    canvas.setModel(model, { refit: true }); regenPanels();
    showRevert(false); status('ok', null, 'layout reverted');
  });

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); newDag(); return; }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z') && !isTyping(e)) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || e.key === 'Y') && !isTyping(e)) { e.preventDefault(); redo(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && !isTyping(e)) { e.preventDefault(); canvas.deleteSelection(); }
    if ((e.key === 'p' || e.key === 'P') && !isTyping(e) && !e.metaKey && !e.ctrlKey) { e.preventDefault(); pointAt(); return; }
    if (e.key === 'Escape') canvas.setMode('select');
  });

  // collapse the side panel
  $('[data-act=collapse]').addEventListener('click', () => {
    const collapsed = stage.querySelector('.dg-app').classList.toggle('side-collapsed');
    $('[data-act=collapse]').textContent = collapsed ? '‹' : '›';
    setTimeout(() => canvas.refit(), 260);
  });

  // ---- configs: save / open / delete ----
  function setCurrent(slug, name) {
    currentSlug = slug; currentName = name || '';
    setDirty(false);
  }
  // Name chip; shows a "•" while edits are pending an auto-save.
  function setDirty(pending) {
    $('#dg-current').textContent = currentName ? `· ${currentName}${pending ? ' •' : ''}` : '';
  }
  // Auto-save the current model back to its config, debounced. No-ops when no
  // config is open (nothing to save to) or while loading one.
  function scheduleAutosave() {
    if (loading || !currentSlug) return;
    setDirty(true);
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(doAutosave, 800);
  }
  async function doAutosave() {
    if (!currentSlug) return;
    const slug = currentSlug, name = currentName;
    model.meta.style = renderStyle; model.meta.swigStyle = swigStyle; model.meta.title = name;
    try {
      const res = await fetch('/dag/api/configs', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, model, slug }),
      });
      if (res.ok && slug === currentSlug) setDirty(false);
    } catch { /* leave the • dot; a later edit retries */ }
  }
  // Persist any pending edits immediately (before switching/closing configs).
  async function flushAutosave() {
    if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; await doAutosave(); }
  }

  // ---- undo / redo (snapshot history; coalesces rapid bursts like a drag) ----
  function recordUndo() {
    const cur = JSON.stringify(model);
    if (cur === lastSnapshot) return;
    const now = Date.now();
    if (now - lastRecordTime > 350 || !undoStack.length) {  // separate action → new step
      undoStack.push(lastSnapshot);
      if (undoStack.length > 200) undoStack.shift();
    }                                                       // else coalesce into the burst
    lastSnapshot = cur; lastRecordTime = now; redoStack = [];
  }
  function resetHistory() { undoStack = []; redoStack = []; lastSnapshot = JSON.stringify(model); lastRecordTime = 0; }
  function restore(serialized) {
    model = JSON.parse(serialized); lastSnapshot = serialized;
    renderStyle = model.meta?.style || renderStyle;
    swigStyle = model.meta?.swigStyle || swigStyle;
    $('[data-act=style]').textContent = renderStyle === 'informal' ? 'Style: Informal' : 'Style: Manuscript';
    $('[data-act=swigStyle]').textContent = swigStyle === 'paren' ? 'SWIG: Y(a)' : 'SWIG: Yᵃ';
    canvas.setStyle(renderStyle); canvas.setSwigStyle(swigStyle); canvas.setModel(model, { refit: false }); canvas.clearSelection();
    regenPanels(); renderInspector(null); invalidateRevert();
  }
  function undo() {
    if (!undoStack.length) { status('ok', null, 'nothing to undo'); return; }
    redoStack.push(lastSnapshot);
    restore(undoStack.pop());
    status('ok', null, `undo — ${undoStack.length} more`);
  }
  function redo() {
    if (!redoStack.length) { status('ok', null, 'nothing to redo'); return; }
    undoStack.push(lastSnapshot);
    restore(redoStack.pop());
    status('ok', null, 'redo');
  }
  async function refreshConfigList() {
    const box = $('#cfg-list');
    let list = [];
    try { list = await (await fetch('/dag/api/configs')).json(); } catch { /* offline */ }
    if (!list.length) { box.innerHTML = '<p class="dg-muted dg-cfg-empty">No saved configs yet.</p>'; return; }
    box.innerHTML = list.map((c) => `
      <div class="dg-cfg-item${c.slug === currentSlug ? ' on' : ''}" data-slug="${esc(c.slug)}">
        <button class="dg-cfg-open" data-open="${esc(c.slug)}" title="open">
          <span class="dg-cfg-name">${esc(c.name)}</span>
          <span class="dg-muted">${c.nodes}n · ${c.edges}e</span>
        </button>
        <button class="dg-cfg-del" data-del="${esc(c.slug)}" title="delete">✕</button>
      </div>`).join('');
    box.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openConfig(b.dataset.open)));
    box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', (ev) => { ev.stopPropagation(); deleteConfig(b.dataset.del); }));
  }
  async function saveConfig() {
    const name = ($('#cfg-name').value || currentName || 'dag').trim();
    model.meta.style = renderStyle; model.meta.swigStyle = swigStyle; model.meta.title = name;
    try {
      const res = await fetch('/dag/api/configs', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, model }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
      const saved = await res.json();
      setCurrent(saved.slug, saved.name);
      await refreshConfigList();
      status('ok', null, `saved “${saved.name}”`);
    } catch (e) { status('warn', null, `save failed: ${e.message}`); }
  }
  async function openConfig(slug) {
    try {
      const cfg = await (await fetch(`/dag/api/configs/${slug}`)).json();
      await flushAutosave();   // persist pending edits to the config we're leaving
      loading = true;
      model = cfg.model;
      renderStyle = model.meta?.style || 'informal';
      swigStyle = model.meta?.swigStyle || 'superscript';
      $('[data-act=style]').textContent = renderStyle === 'informal' ? 'Style: Informal' : 'Style: Manuscript';
      $('[data-act=swigStyle]').textContent = swigStyle === 'paren' ? 'SWIG: Y(a)' : 'SWIG: Yᵃ';
      setCurrent(slug, cfg.name); $('#cfg-name').value = cfg.name;  // set BEFORE regen so autosave targets the right config
      canvas.setStyle(renderStyle); canvas.setSwigStyle(swigStyle); canvas.setModel(model, { refit: true });
      resetHistory(); regenPanels(); renderInspector(null); invalidateRevert();
      $('.dg-configs').open = false;
      status('ok', null, `opened “${cfg.name}”`);
    } catch (e) { status('warn', null, `open failed: ${e.message}`); }
    finally { loading = false; }
  }
  async function deleteConfig(slug) {
    try {
      await fetch(`/dag/api/configs/${slug}`, { method: 'DELETE' });
      if (slug === currentSlug) setCurrent(null, '');
      await refreshConfigList();
    } catch (e) { status('warn', null, `delete failed: ${e.message}`); }
  }
  async function newDag() {
    // Only warn when there's untitled work to lose; open configs are auto-saved.
    if (model.nodes.length && !currentSlug && !confirm('Start a new blank DAG? Unsaved changes will be cleared.')) return;
    await flushAutosave();   // persist the config we're leaving, if any
    loading = true;
    model = { meta: { kind: 'dag', style: renderStyle, swigStyle, title: '', nodeSep: 1 }, nodes: [], edges: [] };
    setCurrent(null, ''); $('#cfg-name').value = '';
    canvas.setModel(model, { refit: true });
    resetHistory(); regenPanels(); renderInspector(null); invalidateRevert();
    $('.dg-configs').open = false;
    status('ok', null, 'new blank DAG — add nodes (+ node) or type a formula');
    loading = false;
  }
  $('[data-cfg=new]').addEventListener('click', newDag);
  $('[data-cfg=save]').addEventListener('click', saveConfig);
  $('#cfg-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveConfig(); } });
  $('.dg-configs').addEventListener('toggle', (e) => { if (e.target.open) refreshConfigList(); });

  // ---- export (native Save dialog → choose where; falls back to download) ----
  stage.querySelectorAll('[data-export]').forEach((b) => b.addEventListener('click', () => doExport(b.dataset.export)));

  const EXPORT_META = {
    json: ['json', 'application/json'], formula: ['txt', 'text/plain'], dagitty: ['txt', 'text/plain'],
    tex: ['tex', 'application/x-tex'], svg: ['svg', 'image/svg+xml'], html: ['html', 'text/html'],
    pdf: ['pdf', 'application/pdf'], png: ['png', 'image/png'], 'svg-tex': ['svg', 'image/svg+xml'],
  };

  async function doExport(fmt) {
    model.meta.style = renderStyle; model.meta.swigStyle = swigStyle;
    const [ext, mime] = EXPORT_META[fmt];
    const base = (currentName || model.meta.title || 'dag').replace(/\W+/g, '-').toLowerCase() || 'dag';
    const name = `${base}.${ext}`;

    const produce = async () => {
      if (fmt === 'json') return JSON.stringify(model, null, 2);
      if (fmt === 'formula') return formula.emit(model);
      if (fmt === 'dagitty') return dagitty.emit(model);
      if (fmt === 'tex') return tikz.emit(model, { wrap: 'standalone' });
      if (fmt === 'svg') return toSVG(model, { style: renderStyle, swigStyle });
      if (fmt === 'html') return toHTML(model, { style: renderStyle, swigStyle });
      const format = fmt === 'svg-tex' ? 'svg' : fmt;  // compiled formats
      status('compiling', null, 'compiling with LaTeX…');
      const res = await fetch('/dag/api/compile', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, format }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.code === 'NO_LATEX' ? 'LaTeX not installed — use SVG/HTML export instead.' : (err.error || `compile ${res.status}`));
      }
      return await res.blob();
    };
    await saveOut(name, mime, ext, produce);
  }

  // Show the OS Save dialog (File System Access API) so the user picks the folder;
  // fall back to a normal download when the API is unavailable, cancelled, or the
  // write is blocked (sandboxed iframes / embedded browser panes expose the picker
  // but forbid createWritable).
  async function saveOut(name, mime, ext, produce) {
    const toBlob = (data) => (data instanceof Blob ? data : new Blob([data], { type: mime }));
    if (window.showSaveFilePicker) {
      let handle;
      try {
        handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: ext.toUpperCase(), accept: { [mime]: ['.' + ext] } }] });
      } catch (e) { if (e.name === 'AbortError') { status('ok'); return; } handle = null; }
      if (handle) {
        let data;
        try { data = await produce(); } catch (e) { status('warn', null, e.message); return; }
        try {
          const w = await handle.createWritable();
          await w.write(toBlob(data));
          await w.close();
          status('ok', null, `saved ${handle.name}`);
        } catch (e) {
          // Picker granted but the write was refused — download the produced data.
          downloadBlob(name, toBlob(data));
          status('ok', null, `downloaded ${name}`);
        }
        return;
      }
    }
    try {
      const data = await produce();
      downloadBlob(name, toBlob(data));
      status('ok', null, `downloaded ${name}`);
    } catch (e) { status('warn', null, e.message); }
  }

  // ---- point at (show, don't tell: hand a running session what's selected) ----
  // Resolves the selection to its grammar handle, copies it to the clipboard
  // (works with no server), and signals the web-context bus with an optional
  // crop so a session can /session-attach and SEE what was pointed at.
  async function pointAt() {
    const p = await canvas.pointAt();
    if (!p || !p.handles.length) { status('warn', null, 'select a node or edge first, then point at it'); return; }
    const handles = p.handles.map((h) => h.handle);
    let copied = false, signalled = false;
    try { await navigator.clipboard.writeText(handles.join(' ')); copied = true; } catch { /* clipboard blocked */ }
    try {
      const res = await fetch('/dag/api/point-at', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handles: p.handles, source: location.href, png: p.png }),
      });
      signalled = res.ok;
    } catch { /* no server (static/embedded) — the handles are still on the clipboard */ }
    const label = handles.length === 1 ? handles[0] : `${handles[0]} +${handles.length - 1} more`;
    const done = [copied && 'copied', signalled && 'signalled'].filter(Boolean).join(' & ');
    status('ok', null, `⌖ ${label}${done ? ` — ${done}` : ' — copy blocked; no session bus'}`);
  }

  // Resolve a selection-set item to its display handle (for the multi-select summary).
  function handleOf(item) {
    if (item.type === 'node') { const n = model.nodes.find((x) => x.id === item.id); return n ? `@node:${n.id}` : ''; }
    const e = model.edges[item.index]; return e ? `@edge:${e.from}->${e.to}` : '';
  }

  // ---- inspector ----
  function renderInspector(sel) {
    const box = $('.dg-inspector');
    const items = Array.isArray(sel) ? sel : (sel ? [sel] : []);
    if (items.length === 0) { box.innerHTML = '<p class="dg-muted">Select a node or edge to edit it. Shift-click or shift-drag to select several, then ⌖ point at all.</p>'; return; }
    if (items.length > 1) {
      box.innerHTML = `<h4>${items.length} selected</h4>
        <p class="dg-muted">${items.map(handleOf).map(esc).join('<br>')}</p>
        <button class="dg-btn dg-swig-btn" data-act="pointAtAll">⌖ point at all (${items.length})</button>
        <p class="dg-muted">Shift-click to add/remove; ⌖ or press <kbd>p</kbd> to point at them together.</p>`;
      $('[data-act=pointAtAll]').addEventListener('click', pointAt);
      return;
    }
    sel = items[0];
    if (sel.type === 'node') {
      const n = model.nodes.find((x) => x.id === sel.id); if (!n) { box.innerHTML = ''; return; }
      box.innerHTML = `
        <h4>Node</h4>
        ${field('id', `<input id="i-id" value="${esc(n.id)}">`)}
        ${field('label', `<input id="i-label" value="${esc(n.label)}">`)}
        ${field('style', select('i-style', NODE_STYLES, n.style))}
        ${field('role', select('i-role', ['(none)', ...ROLES], n.role || '(none)'))}
        ${field('fill', `<input id="i-fill" value="${esc(n.fill || '')}" placeholder="xcolor e.g. green!15" spellcheck="false">`)}
        ${field('stroke', `<input id="i-stroke" value="${esc(n.stroke || '')}" placeholder="e.g. green!55!black" spellcheck="false">`)}
        ${field('text', `<input id="i-text" value="${esc(n.text || '')}" placeholder="label colour" spellcheck="false">`)}
        <p class="dg-muted">pos (${n.x}, ${n.y})</p>
        <button class="dg-btn dg-swig-btn" id="i-intervene">⋔ Intervene → SWIG</button>`;
      $('#i-id').addEventListener('change', (e) => renameNode(n.id, e.target.value.trim()));
      $('#i-label').addEventListener('input', (e) => { n.label = e.target.value; canvas.rerender(); regenPanels(); invalidateRevert(); });
      $('#i-style').addEventListener('change', (e) => { n.style = e.target.value; canvas.rerender(); regenPanels(); invalidateRevert(); });
      $('#i-role').addEventListener('change', (e) => { const v = e.target.value; if (v === '(none)') delete n.role; else n.role = v; canvas.rerender(); regenPanels(); invalidateRevert(); });
      // Colour overrides: comma-free xcolor expressions; empty clears the override.
      const setNodeColour = (key, val) => { val = val.trim(); if (val) n[key] = val; else delete n[key]; canvas.rerender(); regenPanels(); invalidateRevert(); };
      $('#i-fill').addEventListener('input', (e) => setNodeColour('fill', e.target.value));
      $('#i-stroke').addEventListener('input', (e) => setNodeColour('stroke', e.target.value));
      $('#i-text').addEventListener('input', (e) => setNodeColour('text', e.target.value));
      $('#i-intervene').addEventListener('click', () => {
        model = intervene(model, n.id); model.meta.style = renderStyle; model.meta.swigStyle = swigStyle;
        canvas.setModel(model, { refit: true }); canvas.clearSelection();
        regenPanels(); renderInspector(null); invalidateRevert(); status('ok', null, 'SWIG: split treatment into fixed value');
      });
    } else {
      const e = model.edges[sel.index]; if (!e) { box.innerHTML = ''; return; }
      box.innerHTML = `
        <h4>Edge <span class="dg-muted">${esc(e.from)} → ${esc(e.to)}</span></h4>
        ${field('style', select('e-style', EDGE_STYLES, e.style))}
        ${field('label', `<input id="e-label" value="${esc(e.label || '')}" placeholder="branch condition" spellcheck="false">`)}
        ${field('label pos', select('e-labelpos', ['above', 'below', 'left', 'right'], e.labelPos || 'above'))}
        <label class="dg-field"><span>arc</span><span class="dg-arc">
          <button data-arc="-30" title="arc left">⤴</button>
          <button data-arc="0" title="straight">—</button>
          <button data-arc="30" title="arc right">⤵</button>
          <input id="e-bend" type="number" step="5" value="${e.bend}" title="+right / −left (degrees)">
        </span></label>
        <p class="dg-muted">…or drag the edge on the canvas to arc it.</p>`;
      $('#e-style').addEventListener('change', (ev) => { e.style = ev.target.value; canvas.rerender(); regenPanels(); invalidateRevert(); });
      // Edge label: empty clears both label and its position; a new label defaults to 'above'.
      $('#e-label').addEventListener('input', (ev) => {
        const v = ev.target.value;
        if (v) { e.label = v; if (!e.labelPos) e.labelPos = 'above'; } else { delete e.label; delete e.labelPos; }
        canvas.rerender(); regenPanels(); invalidateRevert();
      });
      $('#e-labelpos').addEventListener('change', (ev) => { if (e.label) { e.labelPos = ev.target.value; canvas.rerender(); regenPanels(); invalidateRevert(); } });
      $('#e-bend').addEventListener('input', (ev) => { e.bend = parseInt(ev.target.value, 10) || 0; canvas.rerender(); regenPanels(); invalidateRevert(); });
      box.querySelectorAll('[data-arc]').forEach((b) => b.addEventListener('click', () => {
        e.bend = parseInt(b.dataset.arc, 10); canvas.rerender(); regenPanels(); invalidateRevert(); renderInspector(sel);
      }));
    }
  }

  function renameNode(oldId, newId) {
    if (!newId || newId === oldId || model.nodes.some((n) => n.id === newId)) { renderInspector(canvas.getSelection()); return; }
    model.nodes.forEach((n) => { if (n.id === oldId) n.id = newId; });
    model.edges.forEach((e) => { if (e.from === oldId) e.from = newId; if (e.to === oldId) e.to = newId; });
    if (model.swig) model.swig.interventions.forEach((iv) => { if (iv.node === oldId) iv.node = newId; });
    regenPanels(); invalidateRevert(); canvas.selectNode(newId);  // keep the node's edit menu open
  }

  // ---- helpers ----
  function regenPanels(except) {
    for (const [key, p] of Object.entries(panels)) {
      if (key === except) continue;               // don't clobber the panel being typed in
      if (document.activeElement === p.el) continue;
      p.el.value = p.emit();
    }
    recordUndo();        // every mutation routes through here → snapshot for undo …
    scheduleAutosave();  // … and auto-save to the open config
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
function downloadBlob(name, blob) { const u = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = u; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(u), 1500); }

const TEMPLATE = `
<div class="dg-app">
  <div class="dg-toolbar">
    <strong class="dg-brand">dag-generator</strong>
    <span class="dg-current" id="dg-current"></span>
    <button class="dg-btn" data-act="style">Style: Informal</button>
    <button class="dg-btn" data-act="swigStyle">SWIG: Yᵃ</button>
    <span class="dg-sep"></span>
    <button class="dg-btn" data-act="addNode">+ node</button>
    <button class="dg-btn" data-act="addEdge">+ edge</button>
    <button class="dg-btn" data-act="del">delete</button>
    <button class="dg-btn" data-act="pointAt" title="Point at the selected node/edge (p): copy its @handle and signal a running session">⌖ point at</button>
    <button class="dg-btn" data-act="relayout">auto-layout</button>
    <button class="dg-btn dg-revert" data-act="revert" hidden>↶ revert</button>
    <button class="dg-btn" data-act="fit">fit</button>
    <span class="dg-sep"></span>
    <details class="dg-export dg-configs">
      <summary class="dg-btn">configs ▾</summary>
      <div class="dg-menu">
        <button class="dg-cfg-new" data-cfg="new">＋ New blank DAG</button>
        <div class="dg-save-row">
          <input id="cfg-name" placeholder="name…" spellcheck="false">
          <button data-cfg="save">Save</button>
        </div>
        <div class="dg-cfg-list" id="cfg-list"></div>
      </div>
    </details>
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
      <div class="dg-zoom">
        <button data-act="zoomIn" title="Zoom in">+</button>
        <span class="dg-zoom-label" title="Reset zoom" data-act="zoomFit">100%</span>
        <button data-act="zoomOut" title="Zoom out">&minus;</button>
      </div>
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
