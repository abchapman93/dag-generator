// dag-generator app orchestrator. Exposes mount({ stage, apiBase, config }) as a
// self-managing module so the SAME code runs standalone (index.html) and, later,
// as an analysis-room tab. All engine work is client-side; the server compiles
// LaTeX, stores configs, and is this page's door onto the collab bus (kit).

import * as formula from '/engine/formula.mjs';
import * as dagitty from '/engine/dagitty.mjs';
import * as tikz from '/engine/tikz.mjs';
import { layout } from '/engine/layout.mjs';
import { toSVG } from '/engine/svg.mjs';
import { toHTML } from '/engine/html.mjs';
import { intervene } from '/engine/swig.mjs';
import { NODE_STYLES, EDGE_STYLES, ROLES, cloneModel } from '/engine/model.mjs';
import { formatHandle } from '/engine/handles.mjs';
import { applyPatch, describeOps, touchedHandles } from '/engine/patch.mjs';
import { mountAskCards } from '/kit/ask-cards.mjs';
import { mountRail } from '/kit/rail.mjs';
import { mountChannelPicker } from '/kit/channel-picker.mjs';
import { createCanvas } from '/canvas.mjs';

export const SURFACE = 'dag-generator';   // the bus target for this page's cards

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

export function mount({ stage, apiBase = '/dag/api', config = null }) {
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
  let currentTimer = null;                   // debounced "what's on screen" report (mirror)

  function showRevert(on) { const b = $('[data-act=revert]'); if (b) b.hidden = !on; }
  function invalidateRevert() { if (preLayout) { preLayout = null; showRevert(false); } }

  const canvas = createCanvas($('.dg-canvas-host'), {
    onChange: () => { regenPanels(); status('ok'); renderInspector(canvas.getSelection()); invalidateRevert(); },
    onSelect: (sel) => { renderInspector(sel); renderSelChip(); },
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

  // ---- rail tabs: the three code panels + the session (learning's rail layout) ----
  const TAB_KEY = 'collab-rail-tab:dag-generator';
  function showTab(tab) {
    const session = tab === 'session';
    stage.querySelectorAll('.dg-rail-tab').forEach((x) => {
      const on = x.dataset.tab === tab;
      x.classList.toggle('is-active', on); x.setAttribute('aria-selected', on);
    });
    $('.dg-code-body').hidden = session;
    $('.dg-session').hidden = !session;
    if (!session) {
      activePanel = tab;
      Object.entries(panels).forEach(([k, p]) => p.el.classList.toggle('hidden', k !== activePanel));
    }
    try { localStorage.setItem(TAB_KEY, tab); } catch { /* private mode */ }
  }
  stage.querySelectorAll('.dg-rail-tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

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
  $('[data-act=pointAt]').addEventListener('click', () => send());
  $('[data-act=send]').addEventListener('click', () => send());
  $('#dg-note').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } });
  // Quick replies: one click sends a canned note, composed with anything typed.
  // With a selection it rides as a point-at (handles + crop); without, a message.
  $('.dg-qr').addEventListener('click', (e) => {
    const b = e.target.closest('[data-qr]'); if (b) send(b.dataset.qr);
  });
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

  const onKey = (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); newDag(); return; }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z') && !isTyping(e)) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || e.key === 'Y') && !isTyping(e)) { e.preventDefault(); redo(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && !isTyping(e)) { e.preventDefault(); canvas.deleteSelection(); }
    if ((e.key === 'p' || e.key === 'P') && !isTyping(e) && !e.metaKey && !e.ctrlKey) { e.preventDefault(); send(); return; }
    if (e.key === 'Escape') canvas.setMode('select');
  };
  document.addEventListener('keydown', onKey);

  // ---- the rail (kit): width, fold, and the widen-while-a-card-is-open rule ----
  const rail = mountRail({ host: $('.dg-side'), storageKey: 'collab-rail:dag-generator', label: 'code · session', width: 400, minMain: 420 });
  let savedTab = null;
  try { savedTab = localStorage.getItem(TAB_KEY); } catch { /* private mode */ }
  showTab(['formula', 'tikz', 'dagitty', 'session'].includes(savedTab) ? savedTab : 'formula');

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
      const res = await fetch(`${apiBase}/configs`, {
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
    try { list = await (await fetch(`${apiBase}/configs`)).json(); } catch { /* offline */ }
    if (!list.length) { box.innerHTML = '<p class="dg-muted dg-cfg-empty">No saved configs yet.</p>'; return; }
    box.innerHTML = list.map((c) => `
      <div class="dg-cfg-item${c.slug === currentSlug ? ' on' : ''}" data-slug="${esc(c.slug)}">
        <button class="dg-cfg-open" data-open="${esc(c.slug)}" title="open">
          <span class="dg-cfg-name">${esc(c.name)}</span>${c.origin === 'claude' ? '<span class="dg-badge" title="drafted by a Claude session">Claude</span>' : ''}
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
      const res = await fetch(`${apiBase}/configs`, {
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
      const cfg = await (await fetch(`${apiBase}/configs/${encodeURIComponent(slug)}`)).json();
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
      await fetch(`${apiBase}/configs/${encodeURIComponent(slug)}`, { method: 'DELETE' });
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
      const res = await fetch(`${apiBase}/compile`, {
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
  // Send a signal to the running session. A selection makes it a point-at (handles +
  // crop); a note with no selection is a bare message; nothing at all is a "done"
  // ping. All three go through one door.
  async function pointAt(note) {
    const p = await canvas.pointAt();                 // null when nothing is selected
    const handles = p ? p.handles.map((h) => h.handle) : [];
    const clip = [handles.join(' '), note].filter(Boolean).join(' — ');
    let copied = false, signalled = false;
    if (clip) { try { await navigator.clipboard.writeText(clip); copied = true; } catch { /* clipboard blocked */ } }
    try {
      const res = await fetch(`${apiBase}/signal`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handles: p ? p.handles : [], note: note || undefined, source: location.href, png: p ? p.png : null, channel: picker.getChannel() || undefined }),
      });
      signalled = res.ok;
    } catch { /* no server (static/embedded) — anything copyable is still on the clipboard */ }
    let icon, what;
    if (handles.length) { icon = '⌖'; what = (handles.length === 1 ? handles[0] : `${handles[0]} +${handles.length - 1} more`) + (note ? ' + note' : ''); }
    else if (note) { icon = '✉'; what = `“${note}”`; }
    else { icon = '◉'; what = 'ping'; }
    const done = [copied && 'copied', signalled && 'signalled'].filter(Boolean).join(' & ') || 'no session bus';
    status('ok', null, `${icon} ${what} — ${done}`);
  }

  // The Session tab's send box: one door, the payload decides the kind. A
  // quick-reply preset and typed text combine, so a one-click category can carry
  // a refinement: "Fix this: color — the leaves should follow provenance".
  function send(preset) {
    const inp = $('#dg-note');
    const note = [preset, inp.value.trim()].filter(Boolean).join(' — ');
    pointAt(note || undefined);
    inp.value = '';
  }

  // What a send would point at, in the handle grammar the session receives.
  function renderSelChip() {
    const chip = $('#dg-sel');
    const handles = canvas.getSelection().map(handleOf).filter(Boolean);
    chip.classList.toggle('live', handles.length > 0);
    chip.textContent = !handles.length
      ? 'nothing selected — a note alone is a message, empty is a ping'
      : handles.length === 1 ? handles[0] : `${handles[0]} +${handles.length - 1} more`;
  }

  // ---- the collab bus (kit): channel, ask cards, patch cards, point-back ----
  // The session writes asks to ~/.claude/web-context/outbound/; the kit polls
  // them into the rail and Alec's answer goes back out through the ordinary
  // signal door carrying in_reply_to.
  //
  // GUARDRAIL: an ask is data, not a command to the page. The kit escapes every
  // prompt and label; the payload bodies below escape theirs, and a patch
  // preview is an <img> of an SVG, so nothing from an ask file ever runs here.
  let cards = null;   // assigned below; the picker's onChange can fire first
  const picker = mountChannelPicker({
    container: $('#dg-channel'),
    basePath: apiBase,
    storageKey: 'collab-channel:dag-generator',
    onChange: (id) => { status('ok', null, id ? 'attached to channel' : 'no channel — broadcasting'); cards?.refresh(); },
    onStatus: (kind, msg) => status(kind === 'error' ? 'warn' : 'ok', null, msg),
  });

  const isPatch = (ask) => ask?.payload?.type === 'dag-patch' && Array.isArray(ask.payload.ops);
  const anchorsOf = (ask) => {
    const a = ask?.payload?.anchor;
    const list = Array.isArray(a) ? a : (a ? [a] : []);
    return isPatch(ask) ? [...new Set([...list, ...touchedHandles(ask.payload.ops, model)])] : list;
  };

  // Card bodies. A patch card shows its ops and a preview of the DAG AFTER them,
  // computed here against the live model; any other card carrying `anchor`
  // handles (the session pointing back) gets a Show me.
  function renderPayload(ask) {
    const showMe = anchorsOf(ask).length ? '<button class="dg-btn dg-showme" type="button">⌖ Show me</button>' : '';
    if (!isPatch(ask)) return showMe ? `<div class="dg-card-extra">${showMe}</div>` : '';
    const p = ask.payload;
    const lines = describeOps(p.ops, model).map((d) =>
      `<li class="dg-op dg-op-${d.sign === '+' ? 'add' : d.sign === '−' ? 'del' : 'set'}"><b>${esc(d.sign)}</b> ${esc(d.text)}</li>`).join('');
    const { model: after, conflicts } = applyPatch(model, p.ops);
    let preview = '';
    if (!conflicts.length) {
      try {
        const svg = toSVG(after, { style: renderStyle, swigStyle, background: '#ffffff' });
        preview = `<img class="dg-patch-preview" alt="the DAG after this patch" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}">`;
      } catch { /* no preview is better than no card */ }
    }
    const wrongDag = 'base_slug' in p && (p.base_slug ?? null) !== (currentSlug ?? null);
    return `<div class="dg-patch">
      ${ask.stale ? '<p class="dg-stale">superseded — a newer suggestion for this DAG is open</p>' : ''}
      ${p.rationale ? `<p class="dg-patch-why">${esc(p.rationale)}</p>` : ''}
      <ul class="dg-ops">${lines}</ul>
      ${wrongDag ? `<p class="dg-patch-warn">For ${esc(p.base_slug || 'the unsaved DAG')} — open it to accept.</p>` : ''}
      ${conflicts.length ? `<p class="dg-patch-warn">Doesn't apply to the DAG on screen: ${esc(conflicts.join('; '))}</p>` : preview}
      ${showMe}
    </div>`;
  }

  // Accept / Reject on a patch card. The server validates and records the
  // answer FIRST (stale, superseded, retracted, wrong DAG → 409, card stays);
  // only then does the patch land, as one undo step.
  async function interceptAnswer(ask, { optionId, label, typed }) {
    if (!isPatch(ask)) return false;
    const pick = `${optionId || ''} ${label || ''}`;
    const outcome = /accept/i.test(pick) ? 'accept' : /reject/i.test(pick) ? 'reject' : null;
    if (!outcome) { status('warn', null, 'this card resolves with Accept or Reject'); return true; }
    let next = null;
    if (outcome === 'accept') {
      const r = applyPatch(model, ask.payload.ops);
      if (r.conflicts.length) { status('warn', null, `can't apply: ${r.conflicts.join('; ')}`); return true; }
      next = r.model;
    }
    await reportCurrent();   // the server checks the patch's base against what is on screen NOW
    let res;
    try {
      res = await fetch(`${apiBase}/suggestions/${encodeURIComponent(ask.ask_id)}/resolve`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ outcome, note: typed || undefined, channel: picker.getChannel() || undefined, source: location.href }),
      });
    } catch { status('warn', null, 'could not reach the server'); return true; }
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      status('warn', null, `not applied — ${e.detail || e.error || res.status}`);
      return true;
    }
    if (next) {
      model = next; model.meta.style = renderStyle; model.meta.swigStyle = swigStyle;
      canvas.setModel(model, { refit: true }); canvas.clearSelection();
      lastRecordTime = 0;   // its own undo step, never merged into an edit burst
      regenPanels(); renderInspector(null); invalidateRevert();
      status('ok', null, `✓ applied ${ask.payload.ops.length} change${ask.payload.ops.length === 1 ? '' : 's'} — ⌘Z to undo`);
    } else status('ok', null, '✕ rejected — the session has been told');
    return true;
  }

  // Say something about a card without resolving it (own-resolution cards).
  async function onComment(ask, typed) {
    try {
      const res = await fetch(`${apiBase}/signal`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note: typed, in_reply_to: ask.ask_id, comment: true, channel: ask.channel || picker.getChannel() || undefined, source: location.href }),
      });
      if (res.ok) status('ok', null, `✉ comment sent — “${typed}”`);
      return res.ok;
    } catch { status('warn', null, 'could not send the comment'); return false; }
  }

  cards = mountAskCards({
    container: $('.dg-asks'),
    target: SURFACE,
    basePath: apiBase,
    dismiss: true,
    channel: () => picker.getChannel(),
    onStatus: (kind, msg) => status(kind === 'ok' ? 'ok' : 'warn', null, msg),
    onOpenChange: (open, n) => {
      rail.setOpen(open); rail.setBadge(n);
      const badge = $('.dg-rail-tab[data-tab=session] .dg-rail-badge');
      badge.textContent = n || ''; badge.hidden = !n;
    },
    // A new card brings the Session tab forward — a card nobody can see is not an ask.
    onCardsChanged: (added) => { if (added.length) showTab('session'); },
    renderPayload,
    ownsResolution: isPatch,
    interceptAnswer,
    onComment,
  });

  // Show me: the session pointing back. Select and pulse, only on this click.
  $('.dg-asks').addEventListener('click', (e) => {
    if (!e.target.closest('.dg-showme')) return;
    const ask = e.target.closest('.ck-ask')?._ask;
    const { found, missing } = canvas.selectHandles(anchorsOf(ask));
    if (missing.length) status('warn', null, `not on the canvas any more: ${missing.join(', ')}`);
    else status('ok', null, `⌖ showing ${found} item${found === 1 ? '' : 's'}`);
  });

  // ---- what's on screen → the server (the bus mirror + the patch base) ----
  function scheduleReport() {
    clearTimeout(currentTimer);
    currentTimer = setTimeout(reportCurrent, 800);
  }
  async function reportCurrent() {
    clearTimeout(currentTimer); currentTimer = null;
    model.meta.style = renderStyle; model.meta.swigStyle = swigStyle;
    try {
      await fetch(`${apiBase}/current`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: currentSlug, name: currentName || null, model }),
      });
    } catch { /* no server (static/embedded) — no mirror */ }
  }

  // Resolve a selection-set item to its display handle (for the multi-select summary).
  function handleOf(item) {
    if (item.type === 'node') { const n = model.nodes.find((x) => x.id === item.id); return n ? formatHandle(item) : ''; }
    const e = model.edges[item.index]; return e ? formatHandle({ type: 'edge', from: e.from, to: e.to }) : '';
  }

  // ---- inspector ----
  function renderInspector(sel) {
    const box = $('.dg-inspector');
    const items = Array.isArray(sel) ? sel : (sel ? [sel] : []);
    if (items.length === 0) { box.innerHTML = '<p class="dg-muted">Select a node or edge to edit it. Shift-click / shift-drag to select several.</p>'; return; }
    if (items.length > 1) {
      box.innerHTML = `<h4>${items.length} selected</h4>
        <p class="dg-muted">${items.map(handleOf).map(esc).join('<br>')}</p>
        <button class="dg-btn dg-swig-btn" data-act="pointAtAll">⌖ point at all (${items.length})</button>
        <p class="dg-muted">Shift-click to add/remove; ⌖ or press <kbd>p</kbd> to point at them together.</p>`;
      $('[data-act=pointAtAll]').addEventListener('click', () => send());
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
    scheduleAutosave();  // … auto-save to the open config …
    scheduleReport();    // … and tell the server what's on screen (the bus mirror)
  }
  function status(kind, flags, msg) {
    const el = $('.dg-status');
    el.className = 'dg-status ' + (kind === 'warn' ? 'warn' : kind === 'compiling' ? 'busy' : 'ok');
    if (msg) { el.textContent = msg; return; }
    if (flags && flags.length) el.innerHTML = flags.map((f) => `line ${f.line}: ${esc(f.why)}`).join(' · ');
    else el.textContent = `${model.nodes.length} nodes · ${model.edges.length} edges`;
  }

  regenPanels(); renderInspector(null); renderSelChip(); status('ok');
  if (config) openConfig(config);
  // destroy() exists for the timers and listeners: as an analysis-room tab this
  // module can be unmounted, and a poll or keydown outliving its stage would keep
  // running forever.
  return {
    getModel: () => model,
    destroy: () => {
      document.removeEventListener('keydown', onKey);
      clearTimeout(autosaveTimer); clearTimeout(currentTimer);
      cards.destroy(); picker.destroy(); rail.destroy();
    },
  };
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
    <a class="dg-btn dg-home" href="https://${location.hostname}:4710/" aria-label="Home" title="Home"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 11l8-6.5 8 6.5M6 9.5V19.5h4.5v-5h3v5H18V9.5"/></svg></a>
    <strong class="dg-brand">dag-generator</strong>
    <span class="dg-current" id="dg-current"></span>
    <button class="dg-btn" data-act="style">Style: Informal</button>
    <button class="dg-btn" data-act="swigStyle">SWIG: Yᵃ</button>
    <span class="dg-sep"></span>
    <button class="dg-btn" data-act="addNode">+ node</button>
    <button class="dg-btn" data-act="addEdge">+ edge</button>
    <button class="dg-btn" data-act="del">delete</button>
    <button class="dg-btn" data-act="pointAt" title="Send to the session (p)">⌖ point at</button>
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
      <div class="dg-rail-head">
        <div class="dg-rail-tabs" role="tablist">
          <button class="dg-rail-tab" role="tab" data-tab="formula">Formula</button>
          <button class="dg-rail-tab" role="tab" data-tab="tikz">TikZ</button>
          <button class="dg-rail-tab" role="tab" data-tab="dagitty">Dagitty</button>
          <button class="dg-rail-tab" role="tab" data-tab="session">Session<span class="dg-rail-badge" hidden></span></button>
        </div>
      </div>
      <div class="dg-rail-body dg-code-body" role="tabpanel">
        <div class="dg-panels">
          <textarea id="p-formula" class="dg-code" spellcheck="false"></textarea>
          <textarea id="p-tikz" class="dg-code hidden" spellcheck="false"></textarea>
          <textarea id="p-dagitty" class="dg-code hidden" spellcheck="false"></textarea>
        </div>
        <div class="dg-inspector"></div>
      </div>
      <div class="dg-rail-body dg-session" role="tabpanel" hidden>
        <div class="dg-channel" id="dg-channel"></div>
        <div class="dg-send">
          <p class="dg-section-label">Send to Claude</p>
          <p class="dg-sel" id="dg-sel"></p>
          <textarea id="dg-note" rows="2" placeholder="a note on the selection, or a message to Claude…" spellcheck="false"></textarea>
          <div class="dg-send-row">
            <button class="dg-btn dg-btn-accent" data-act="send" title="⌘Enter">⌖ send</button>
          </div>
          <div class="dg-qr">
            <span class="dg-qr-label">Fix this:</span>
            <button data-qr="Fix this: position">position</button>
            <button data-qr="Fix this: text">text</button>
            <button data-qr="Fix this: color">color</button>
            <button data-qr="Fix this: shape">shape</button>
            <span class="dg-qr-gap"></span>
            <button data-qr="Looks good">✓ looks good</button>
            <button data-qr="Done">done</button>
          </div>
        </div>
        <div class="ck-asks dg-asks" hidden></div>
      </div>
      <div class="dg-status ok"></div>
    </aside>
  </div>
</div>`;
