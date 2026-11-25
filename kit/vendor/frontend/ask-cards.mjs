// Ask cards — the return channel rendered in a surface, generalized from
// dag-generator's app.mjs. A running session has no inbound control channel and
// can't be pushed to — but this page can poll. The session writes an ask to
// ~/.claude/web-context/outbound/; we pull the unanswered ones, render each as
// a card, and the human's click goes back out through the ORDINARY signal door
// carrying in_reply_to. The loop closes without the session needing a port.
//
// GUARDRAIL: an ask is data, not a command to the page. Prompts and labels are
// escaped first and only then read as markdown and math (see withRichText), and
// the chosen label is echoed back — nothing from an ask file is ever evaluated
// here.
//
// mountAskCards({
//   container,                    // element the cards render into
//   target,                       // this surface's slug ("editor")
//   basePath,                     // API prefix; polls `${basePath}/asks`, answers to `${basePath}/signal`
//   onStatus(kind, msg),          // surface's status line
//   onOpenChange(open, count),    // true while any ask is pending (panel widening).
//                                 // `count` comes along because it is called BEFORE the
//                                 // cards are painted, so a surface that counted the
//                                 // rendered nodes itself would always be one poll behind.
//   onCardsChanged(added, removed, asks),
//                                 // optional: which ask ids appeared and which went,
//                                 // called AFTER the paint (unlike onOpenChange) so the
//                                 // new cards are queryable. New cards also carry the
//                                 // class `ck-ask-new` — inert without CSS; the coach
//                                 // avatar's bubble pop hangs off it.
//   renderPayload(ask) -> html,   // optional: extra card body for asks carrying a payload
//                                 // (e.g. a suggestion diff). Html that mints its own
//                                 // `.ck-ask-opt` buttons owns the card's resolution: the
//                                 // kit suppresses its generic send for that card (the
//                                 // free-text input remains and rides along as `typed`).
//   interceptAnswer(ask, {optionId, label, typed}) -> Promise<boolean>,
//                                 // optional: handle an answer app-side (a suggestion's
//                                 // resolve endpoint); return true to skip the default POST
//   ownsResolution(ask) -> bool,  // optional: this card resolves ONLY through its own
//                                 // options (they route to interceptAnswer), so the
//                                 // generic send is a decoy — drop it. Say true for any
//                                 // card whose options DO something; the free-text input
//                                 // stays and rides along as `typed`.
//   onComment(ask, typed) -> Promise<bool>,
//                                 // optional, own-resolution cards only: send the typed
//                                 // text to the session WITHOUT answering the ask, so the
//                                 // card stays live. Supply it and the kit renders a
//                                 // `comment` button beside the input. Opt-in, because a
//                                 // surface whose server stamps on any in_reply_to would
//                                 // otherwise resurrect the decoy it just removed.
//   askClaude: { label, placeholder, sendLabel },
//                                 // optional, with onComment: put that comment action on
//                                 // EVERY card under this label, on its own row, even a
//                                 // card that takes no free text. Enter sends it, never
//                                 // the answer. `sendLabel` renames the generic send.
//   dismiss,                      // optional: put a ✕ on every card — "clear this,
//                                 // I'm not answering it". `true` posts to
//                                 // `${basePath}/asks/<id>/dismiss`; a FUNCTION
//                                 // (ask) -> Promise<bool> lets the surface do its
//                                 // own thing (true = it's gone, repaint). Omitted,
//                                 // no ✕ is drawn — a control that 404s is worse
//                                 // than one that isn't there.
//                                 // NEVER emits a signal: see dismiss() below.
//   renderMath(tex, display) -> html | null,
//                                 // optional: a surface's math renderer (see withMath).
//                                 // Markdown needs no hook — the kit renders it itself.
//   channel,                      // optional: scope the poll to a channel. A string, or a
//                                 // FUNCTION returning the current channel id (the picker's
//                                 // getChannel) so a mid-session switch takes effect on the
//                                 // next poll without remounting. Rides on the answer POST
//                                 // too, so the answer signal lands on the same feed.
//   order(asks) -> asks,          // optional: the order to paint them in (the server's
//                                 // is newest first). Runs on every poll, so call poll()
//                                 // after changing what it depends on.
//   pollMs,                       // default 2000
// }) -> { refresh, destroy }

export function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// Math delimiters, in the order the alternation should try them: `$$` before a
// lone `$`, display brackets before inline parens. The inline `$…$` body may not
// cross a newline — a lone `$` in prose would otherwise swallow the rest of the
// card looking for its partner.
const MATH_RE = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\$((?:[^$\\\n]|\\.)+?)\$|\\\(((?:[^\\]|\\[^)])+?)\\\)/g;

// Escape a card's text, interpreting math delimiters if — and only if — the
// surface supplied a renderer.
//
// GUARDRAIL, extended: the kit still owns the escaping, so a prompt's `<img
// onerror=…>` can no more reach innerHTML than before. What the surface gets is
// the TeX between the delimiters, unescaped (`$p < .05$` has to arrive as `<`,
// not `&lt;`, or every inequality renders as an error), and what it returns is
// markup it built itself from that TeX. A renderer that instead echoed its input
// as HTML would hand the guardrail back — KaTeX's default trust:false does not.
// A renderer that throws or returns null leaves the segment as literal text.
export function withMath(text, renderMath) {
  const s = clean(text);
  if (!renderMath) return esc(s);
  const { src, math } = liftMath(s, renderMath);
  return restoreMath(esc(src), math);
}

// The sentinels below stand in for already-built markup while a later pass runs
// over the text. They are stripped from the input first so a card can never
// forge one — a prompt carrying \u0000 would otherwise reach in and place its
// own text where a rendered equation belongs.
function clean(text) { return String(text == null ? '' : text).replace(/[\u0000\u0001]/g, ''); }

// Pull every math span out to one side, leaving a \u0000N\u0000 marker in the
// text. Whatever runs over the text next — escaping, markdown — then cannot see
// the TeX (a subscript's `_` is not emphasis) or the renderer's markup.
// A segment the renderer refuses stays in the text as its literal source.
function liftMath(s, renderMath) {
  const math = [];
  let out = '', at = 0, m;
  MATH_RE.lastIndex = 0;
  while ((m = MATH_RE.exec(s)) !== null) {
    const display = m[1] !== undefined || m[2] !== undefined;
    const tex = m[1] ?? m[2] ?? m[3] ?? m[4];
    let html = null;
    try { html = renderMath(tex, display); } catch { html = null; }
    out += s.slice(at, m.index) + (html == null ? m[0]
      : `\u0000${math.push(`<span class="ck-math${display ? ' ck-math-display' : ''}">${html}</span>`) - 1}\u0000`);
    at = m.index + m[0].length;
  }
  return { src: out + s.slice(at), math };
}

function restoreMath(html, math) { return html.replace(/\u0000(\d+)\u0000/g, (_, i) => math[i]); }

// Card prose, the way the session wrote it: escaped, math typeset, and a small
// markdown subset applied — paragraphs, headings, lists, fenced and inline code,
// `**strong**`, `*em*`/`_em_`. A coach writing a derivation reaches for those the
// same way it reaches for `$…$`, and a card that shows `**Both fixed**` as
// asterisks is reading its author's markup aloud.
//
// GUARDRAIL, unchanged: the kit still owns the escaping and does it BEFORE any
// markdown transform, so the subset is applied to text that can no longer become
// a tag. No markdown library is used and none should be — `marked` and friends
// pass raw HTML straight through, which would hand back the one thing this file
// guarantees. Links are deliberately absent for the same reason: nothing in a
// card should be clickable to somewhere.
export function withRichText(text, renderMath) {
  const s = clean(text);
  const { src, math } = renderMath ? liftMath(s, renderMath) : { src: s, math: [] };
  return restoreMath(markdownBlocks(src), math);
}

// Inline markdown over ALREADY-ESCAPED text. Code spans are lifted out first so
// their contents are literal — `**` inside backticks is two asterisks. Emphasis
// requires a non-space next to the delimiter and (for the single-character
// forms) a word boundary outside it, so `snake_case_name` and `2 * 3 * 4` are
// left alone.
function markdownInline(escaped) {
  const code = [];
  let s = escaped.replace(/`([^`\n]+)`/g, (_, c) => `\u0001${code.push(`<code>${c}</code>`) - 1}\u0001`);
  s = s.replace(/\*\*(\S|\S[\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s([])\*(\S|\S[^*]*\S)\*(?=[\s)\].,;:!?]|$)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[\s([])_(\S|\S[^_]*\S)_(?=[\s)\].,;:!?]|$)/g, '$1<em>$2</em>');
  return s.replace(/\u0001(\d+)\u0001/g, (_, i) => code[i]);
}

const MD_FENCE = /^\s*```/;
const MD_HEADING = /^(#{1,6})\s+(.+)$/;
const MD_BULLET = /^\s*[-*+]\s+(.+)$/;
const MD_NUMBER = /^\s*\d+[.)]\s+(.+)$/;

// Block markdown. Deliberately flat — no nesting, no tables, no block quotes:
// this renders one side of a conversation in a 340px rail, not a document.
function markdownBlocks(src) {
  const lines = src.split('\n');
  const blocks = [];
  let para = [];
  const flush = () => {
    if (!para.length) return;
    const body = para.join('\n');
    para = [];
    // A display equation alone in its paragraph is the block; wrapping it in a
    // <p> would only add the paragraph's margins to the ones it already has.
    if (/^\u0000\d+\u0000$/.test(body)) { blocks.push({ tag: null, html: body }); return; }
    // Single newlines inside a paragraph are the author's own breaks (the store
    // stopped flattening prompts on 2026-07-28) and stay visible as <br>.
    blocks.push({ tag: 'p', html: markdownInline(esc(body)).replace(/\n/g, '<br>') });
  };

  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { flush(); i++; continue; }
    if (MD_FENCE.test(line)) {
      flush(); i++;
      const buf = [];
      while (i < lines.length && !MD_FENCE.test(lines[i])) buf.push(lines[i++]);
      i++;   // the closing fence, or the end of the text if it was never closed
      blocks.push({ tag: null, html: `<pre><code>${esc(buf.join('\n'))}</code></pre>` });
      continue;
    }
    const h = MD_HEADING.exec(line);
    if (h) {
      flush();
      // `#` lands at h3: a card sits inside the surface's own headings.
      const level = Math.min(6, h[1].length + 2);
      blocks.push({ tag: null, html: `<h${level}>${markdownInline(esc(h[2]))}</h${level}>` });
      i++; continue;
    }
    const ordered = !MD_BULLET.test(line) && MD_NUMBER.test(line);
    if (ordered || MD_BULLET.test(line)) {
      flush();
      const re = ordered ? MD_NUMBER : MD_BULLET;
      const items = [];
      let item;
      while (i < lines.length && (item = re.exec(lines[i]))) { items.push(`<li>${markdownInline(esc(item[1]))}</li>`); i++; }
      const tag = ordered ? 'ol' : 'ul';
      blocks.push({ tag: null, html: `<${tag}>${items.join('')}</${tag}>` });
      continue;
    }
    para.push(line); i++;
  }
  flush();

  // One paragraph and nothing else — the overwhelming majority of asks, and
  // every option label — renders as bare inline markup. A <p> in a button is
  // a wrapper nobody asked for.
  if (blocks.length === 1 && blocks[0].tag === 'p') return blocks[0].html;
  return blocks.map((b) => (b.tag === 'p' ? `<p>${b.html}</p>` : b.html)).join('');
}

// Which ask ids are new since the last paint, pure. `knownIds` is kept by the
// caller ACROSS paints — deliberately not derived from the render signature,
// whose null sentinel means "repaint regardless": diffing against that would
// replay every card as new each time an answer forces a repaint.
export function diffAskIds(knownIds, asks) {
  const ids = asks.map((a) => a.ask_id);
  const idSet = new Set(ids);
  return {
    added: ids.filter((id) => !knownIds.has(id)),
    removed: [...knownIds].filter((id) => !idSet.has(id)),
    ids,
  };
}

// Inline word diff for a suggestion payload: one run of text with the removed
// words struck through and the added words marked, instead of the whole
// before-block over the whole after-block. A paragraph with three numbers
// changed reads as three small marks, which is the point — reviewing the two
// blocks side by side to find them was the friction (Overleaf review,
// 2026-09-10). Returns escaped HTML for the host to wrap in `.ck-diff
// .ck-diff-inline`, or null when the two texts share too little for
// strike-through to be readable (a rewrite, an insertion from nothing, or
// texts too long to align) — the host falls back to the block diff then.
//
// Tokens are words and whitespace runs; the alignment is a plain LCS over the
// middle that remains after the common prefix/suffix are stripped, which is
// what makes a targeted edit in a long paragraph cheap. Equal whitespace
// sitting between two changes is folded into the change so a rewritten phrase
// is one del + one ins, not a word-by-word alternation.
const DIFF_CELL_CAP = 4_000_000;      // m*n of the aligned middle; above it, the block view
const DIFF_REWRITE_RATIO = 0.5;       // changed words / all words; above it, the block view

export function diffWordsHtml(before, after) {
  const a = String(before).match(/\s+|\S+/g) || [];
  const b = String(after).match(/\s+|\S+/g) || [];
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const ma = a.slice(head, a.length - tail);
  const mb = b.slice(head, b.length - tail);
  if (ma.length * mb.length > DIFF_CELL_CAP) return null;

  // LCS table over the middle, then a backtrack into ops.
  const n = ma.length, m = mb.length;
  const L = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i * (m + 1) + j] = ma[i] === mb[j]
        ? L[(i + 1) * (m + 1) + j + 1] + 1
        : Math.max(L[(i + 1) * (m + 1) + j], L[i * (m + 1) + j + 1]);
    }
  }
  const ops = [];   // [kind, token] with kind in '=', '-', '+'
  for (const t of a.slice(0, head)) ops.push(['=', t]);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (ma[i] === mb[j]) { ops.push(['=', ma[i]]); i++; j++; }
    else if (L[(i + 1) * (m + 1) + j] >= L[i * (m + 1) + j + 1]) ops.push(['-', ma[i++]]);
    else ops.push(['+', mb[j++]]);
  }
  while (i < n) ops.push(['-', ma[i++]]);
  while (j < m) ops.push(['+', mb[j++]]);
  for (const t of a.slice(a.length - tail)) ops.push(['=', t]);

  // Group into hunks. An equal run made only of whitespace, with a change on
  // both sides, joins the surrounding change (appears in both del and ins).
  const isWs = (t) => /^\s+$/.test(t);
  const hunks = [];   // { eq: string } | { del: string, ins: string }
  let k = 0;
  while (k < ops.length) {
    if (ops[k][0] === '=') {
      let run = '';
      while (k < ops.length && ops[k][0] === '=') run += ops[k++][1];
      const prev = hunks[hunks.length - 1];
      const nextIsChange = k < ops.length;   // ops[k] is '-' or '+'
      if (prev && 'del' in prev && nextIsChange && isWs(run)) { prev.del += run; prev.ins += run; }
      else hunks.push({ eq: run });
      continue;
    }
    let del = '', ins = '';
    while (k < ops.length && ops[k][0] !== '=') { if (ops[k][0] === '-') del += ops[k][1]; else ins += ops[k][1]; k++; }
    const prev = hunks[hunks.length - 1];
    if (prev && 'del' in prev) { prev.del += del; prev.ins += ins; }
    else hunks.push({ del, ins });
  }

  const words = (s) => (s.match(/\S+/g) || []).length;
  let changed = 0;
  for (const h of hunks) if ('del' in h) changed += words(h.del) + words(h.ins);
  const total = words(before) + words(after);
  if (!total || changed / total > DIFF_REWRITE_RATIO) return null;

  return hunks.map((h) => ('eq' in h
    ? esc(h.eq)
    : `${h.del ? `<del>${esc(h.del)}</del>` : ''}${h.ins ? `<ins>${esc(h.ins)}</ins>` : ''}`)).join('');
}

export function mountAskCards({ container, target, basePath, onStatus = () => {}, onOpenChange = () => {}, onCardsChanged = null, renderPayload = null, interceptAnswer = null, ownsResolution = null, onComment = null, askClaude = null, dismiss: dismissOpt = null, renderMath = null, channel = null, order = null, pollMs = 2000 }) {
  const currentChannel = () => (typeof channel === 'function' ? channel() : channel) || null;
  // ids currently on screen; skips repaints that would wipe half-typed free
  // text under the cursor. null (not '') means "repaint regardless" — '' is the
  // real signature of an empty list, so using it as the sentinel would swallow
  // exactly the repaint that clears the last answered card.
  let rendered = null;
  let timer = null;
  const listening = new AbortController();   // destroy() detaches the container's listeners
  const knownIds = new Set();   // for diffAskIds — survives forced repaints

  async function poll() {
    let asks = [];
    try {
      const ch = currentChannel();
      const res = await fetch(`${basePath}/asks?target=${encodeURIComponent(target)}${ch ? `&channel=${encodeURIComponent(ch)}` : ''}`);
      if (!res.ok) return;
      asks = await res.json();
    } catch { return; }   // no server (static/embedded) — the channel is simply off
    if (order) asks = order(asks);
    const sig = asks.map((a) => a.ask_id).join(',');
    if (sig === rendered) return;
    rendered = sig;
    render(asks);
  }

  // A repaint rebuilds the whole card list, so any text a human has typed into a
  // card but not yet submitted — a note box, an edited description/rewrite — is
  // wiped when SOME OTHER card resolves and forces the refresh. Snapshot every
  // control's value by (ask id, ordinal within the card) before the rebuild and
  // restore it after, for cards still on screen. Ordinal keying is stable
  // because a card's markup is deterministic over its ask/payload; a genuinely
  // new card has a new ask id and matches nothing, so nothing stale leaks in.
  function captureDrafts() {
    const drafts = new Map();
    container.querySelectorAll('.ck-ask').forEach((card) => {
      const vals = [...card.querySelectorAll('input, textarea, select')].map(
        (el) => (el.type === 'checkbox' || el.type === 'radio' ? { checked: el.checked } : { value: el.value }));
      drafts.set(card.dataset.ask, vals);
    });
    return drafts;
  }
  function restoreDraft(card, active, drafts) {
    const vals = drafts.get(card.dataset.ask);
    if (!vals) return;
    const controls = card.querySelectorAll('input, textarea, select');
    controls.forEach((el, i) => {
      const v = vals[i];
      if (!v) return;
      if (el.type === 'checkbox' || el.type === 'radio') { if ('checked' in v) el.checked = v.checked; }
      else if ('value' in v && el.value !== v.value) el.value = v.value;
    });
    // Keep the caret where the human left it if they were mid-edit here.
    if (active && card.dataset.ask === active.ask) {
      const el = controls[active.idx];
      if (el && typeof el.focus === 'function') {
        el.focus();
        try { el.setSelectionRange(active.start, active.end); } catch { /* unsupported input type */ }
      }
    }
  }
  // Where the caret is right now, so a background repaint doesn't yank focus.
  function activeDraft() {
    const el = document.activeElement;
    const card = el && el.closest && el.closest('.ck-ask');
    if (!card) return null;
    const controls = [...card.querySelectorAll('input, textarea, select')];
    const idx = controls.indexOf(el);
    if (idx < 0) return null;
    let start = null, end = null;
    try { start = el.selectionStart; end = el.selectionEnd; } catch { /* unsupported */ }
    return { ask: card.dataset.ask, idx, start, end };
  }

  // data-label carries the RAW label while the visible span is typeset: the
  // attribute is what gets echoed back to the session as the answer, and
  // "$\hat\beta$ is unbiased" is the readable form there.
  function render(asks) {
    container.hidden = !asks.length;
    onOpenChange(asks.length > 0, asks.length);
    const { added, removed, ids } = diffAskIds(knownIds, asks);
    knownIds.clear();
    for (const id of ids) knownIds.add(id);
    const changed = () => { if (onCardsChanged && (added.length || removed.length)) onCardsChanged(added, removed, asks); };
    if (!asks.length) { container.innerHTML = ''; changed(); return; }
    const drafts = captureDrafts();
    const active = activeDraft();
    container.innerHTML = asks.map((a) => {
      const body = renderPayload && a.payload ? renderPayload(a) : '';
      // A card whose OPTIONS do the work owns its own resolution; the generic
      // send would answer with optionId '' — a decoy that falls through every
      // interceptAnswer match and burns the ask through the plain signal door.
      // Keep the input (it rides along as `typed` into the real action), drop
      // the send.
      //
      // Two ways to own resolution, because the hole was found twice. A payload
      // that mints its own .ck-ask-opt buttons is detectable here (voice-
      // workshop, 2026-07-26). A card whose actions are the ASK'S OWN options,
      // routed to interceptAnswer, is not — the markup looks identical to an
      // ordinary multiple-choice card, and the editor's suggestion cards sat in
      // that blind spot with a live decoy beside every accept/reject. Only the
      // surface knows, so it says so.
      const ownActions = /\bck-ask-opt\b/.test(body)
        || (a.options.length > 0 && !!ownsResolution && !!ownsResolution(a));
      return `
      <div class="ck-ask" data-ask="${esc(a.ask_id)}">
        ${dismissOpt ? `<button class="ck-ask-dismiss" type="button" title="Dismiss this card — no answer is sent" aria-label="Dismiss this card">✕</button>` : ''}
        <div class="ck-ask-q">${withRichText(a.prompt, renderMath)}</div>
        ${body}
        ${a.options.length ? `<div class="ck-ask-opts">${a.options.map((o) => `
          <button class="ck-ask-opt" data-opt="${esc(o.id)}" data-label="${esc(o.label)}">
            ${o.image ? `<img src="${esc(o.image)}" alt="">` : ''}
            <span>${withRichText(o.label, renderMath)}</span>
          </button>`).join('')}</div>` : ''}
        ${onComment && askClaude ? `<div class="ck-ask-free ck-ask-free-stacked">
          <input class="ck-ask-text" placeholder="${esc(askClaude.placeholder || '')}" spellcheck="false">
          <div class="ck-ask-free-btns">
            <button class="ck-ask-comment">${esc(askClaude.label)}</button>
            ${!ownActions && a.allow_free_text ? `<button class="ck-ask-send" data-opt="" data-label="">${esc(askClaude.sendLabel || 'send')}</button>` : ''}
          </div>
        </div>` : a.allow_free_text ? `<div class="ck-ask-free">
          <input class="ck-ask-text" placeholder="${ownActions ? (onComment ? 'a note — rides with your choice, or comment on its own…' : 'add a note — sent with your choice…') : a.options.length ? 'or answer in your own words…' : 'your answer…'}" spellcheck="false">
          ${ownActions
            ? (onComment ? `<button class="ck-ask-comment">comment</button>` : '')
            : `<button class="ck-ask-send" data-opt="" data-label="">send</button>`}
        </div>` : ''}
      </div>`;
    }).join('');
    container.querySelectorAll('.ck-ask').forEach((card) => {
      card._ask = asks.find((a) => a.ask_id === card.dataset.ask);
      // Only genuinely new cards get the enter hook: a repaint that re-lays
      // existing cards (an answer's forced refresh) must not replay their pop.
      if (added.includes(card.dataset.ask)) card.classList.add('ck-ask-new');
      restoreDraft(card, active, drafts);
    });
    changed();
  }

  // Answer one ask. A chosen option and typed text COMPOSE into a single note:
  // the option is the general answer, the typed text refines it.
  async function answer(card, optionId, label) {
    const typed = card.querySelector('.ck-ask-text')?.value.trim() || '';
    const note = [label, typed].filter(Boolean).join(' — ');
    if (!note) { onStatus('warn', 'answer is empty'); return; }
    if (interceptAnswer && await interceptAnswer(card._ask, { optionId, label, typed })) {
      rendered = null; poll();
      return;
    }
    try {
      const res = await fetch(`${basePath}/signal`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        // The answer rides the ASK'S channel when it has one, else the
        // surface's current one: a channel-X question must not be answered
        // into channel-Y silence just because the picker moved.
        body: JSON.stringify({ note, in_reply_to: card.dataset.ask, option_id: optionId || undefined, channel: card._ask?.channel || currentChannel() || undefined, source: location.href }),
      });
      if (!res.ok) throw new Error('refused');
      onStatus('ok', `↩ answered — “${note}”`);
      rendered = null;   // force the next poll to repaint rather than diff-skip
      poll();
    } catch { onStatus('warn', 'could not send the answer'); }
  }

  // Say something about a card without resolving it. Removing the decoy send
  // closed the hole where a typed answer silently burned the ask — but the
  // decoy was doing two jobs, and carrying the human's words was the one worth
  // keeping. Without this, an own-resolution card offers a text box with no
  // destination except accept/reject, which is its own way of swallowing input.
  async function comment(card) {
    const input = card.querySelector('.ck-ask-text');
    const typed = input?.value.trim() || '';
    if (!typed) { onStatus('warn', 'nothing to say yet'); return; }
    if (await onComment(card._ask, typed)) {
      if (input) input.value = '';   // sent — don't leave it looking unsent
    }
  }

  // Clear a card without answering it. NOT an answer and NOT a refusal to
  // engage: a card can be a good question from a session that is no longer
  // running, and the alternatives are answering it dishonestly or living with a
  // stack of stale cards on top of today's work.
  //
  // NOTHING HERE SENDS A SIGNAL, and the default POST goes to a route that must
  // not send one either. The case this exists for is clearing what a dead
  // session left behind before starting a new one — the session that would hear
  // the "dismissed" is a different session, which never wrote the card and can
  // only be confused by it.
  async function dismissAsk(askId, ask = null) {
    if (!askId) return;
    if (typeof dismissOpt === 'function') {
      // `ask` is null when a surface calls the exposed dismiss() for a card it
      // renders itself; the id is the one thing every caller has.
      if (await dismissOpt(ask || { ask_id: askId })) { rendered = null; poll(); }
      return;
    }
    try {
      const res = await fetch(`${basePath}/asks/${encodeURIComponent(askId)}/dismiss`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: ask?.channel || currentChannel() || undefined, source: location.href }),
      });
      if (!res.ok) throw new Error('refused');
      onStatus('ok', '✕ dismissed — nothing sent to the session');
      rendered = null;
      poll();
    } catch { onStatus('warn', 'could not dismiss that card'); }
  }

  container.addEventListener('click', (e) => {
    const x = e.target.closest('.ck-ask-dismiss');
    if (x) { const card = x.closest('.ck-ask'); dismissAsk(card.dataset.ask, card._ask); return; }
    if (e.target.closest('.ck-ask-comment')) { comment(e.target.closest('.ck-ask')); return; }
    const btn = e.target.closest('.ck-ask-opt, .ck-ask-send');
    if (!btn) return;
    answer(btn.closest('.ck-ask'), btn.dataset.opt, btn.dataset.label);
  }, { signal: listening.signal });
  container.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target.classList.contains('ck-ask-text')) return;
    const card = e.target.closest('.ck-ask');
    // Enter follows whichever button the card actually has. It must never open
    // the decoy path a card no longer offers — but on an own-resolution card
    // with a comment button, Enter in the box means what it looks like.
    if (card.querySelector('.ck-ask-comment')) { comment(card); return; }
    if (!card.querySelector('.ck-ask-send')) return;
    answer(card, '', '');
  }, { signal: listening.signal });

  poll();
  timer = setInterval(poll, pollMs);
  // destroy() exists for the poll timer and the listeners: mounted as a tab in a
  // larger app, this module can be unmounted, and an interval outliving its
  // stage would keep fetching forever. A host that remounts into the SAME
  // container would otherwise keep every earlier mount answering its clicks.
  // `dismiss` is exposed as well as bound to the ✕ because a surface can list
  // cards the panel isn't rendering — learning's tail of asks belonging to
  // another subject — and those rows need the same door, not a second one.
  // `poll` is the diff-skipping look (what a push nudge wants: a half-typed
  // answer survives it); `refresh` forces the repaint.
  live.add(poll);
  return { poll, refresh: () => { rendered = null; return poll(); }, dismiss: dismissAsk, destroy: () => { live.delete(poll); clearInterval(timer); timer = null; listening.abort(); } };
}

// Every card list mounted on this page, so a push nudge (kit/frontend/events.mjs)
// can look in all of them — the top-level feed and an open thread's — without
// the host keeping its own registry.
const live = new Set();
export function pollAllCards() { for (const poll of live) poll(); }
