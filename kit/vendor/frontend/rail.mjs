// Rail — the collapsible, drag-resizable sidebar a surface mounts its cards in.
//
// Three surfaces grew a rail by hand and no two agreed on what an open ask card
// should do to its width. The collab editor OVERRODE it (340 → 480, a CSS rule
// the reader could not argue with, and no way to collapse or resize at all);
// research-lounge's editor dropped the widen entirely and counts pending cards
// in a badge; the learning app split the difference. This is the learning app's
// rule, promoted:
//
//   the width you set is yours, until it cannot hold a card.
//
// So an open ask raises a FLOOR rather than replacing the width — a rail the
// reader has already dragged past 480 stays exactly where they put it — and a
// collapsed rail expands, because a card nobody can see is not an ask. When the
// asks clear, the floor lifts and the rail returns to their width, not to a
// default.
//
// mountRail({
//   host,           // the rail element: a flex child of the surface's main row
//   storageKey,     // localStorage key, one per surface ("collab-rail:editor")
//   minMain,        // px the surface's own content keeps for itself. A number,
//                   // or a FUNCTION returning it — the editor's .tex mode adds
//                   // a PDF pane beside the source, so "how much room the stage
//                   // needs" is not a constant.
//   width,          // default width before the reader has touched it (340)
//   label,          // shown down the folded strip, so a 34px column says what
//                   // it is. Only drawn while collapsed — an expanded rail is
//                   // showing its own contents and does not need naming.
// }) -> { setOpen, setBadge, collapse, expand, toggle, isCollapsed, applyWidth, destroy }
//
//   setOpen(open)   the widen-while-an-ask-is-open rule (raises the floor,
//                   unfolds a collapsed rail)
//   setBadge(n)     pending-card count; shown folded AND expanded, since cards
//                   below the fold are as invisible as cards behind a collapse
//
// Width and collapsed-ness persist per surface, across reloads.

export const RAIL_MIN = 260;      // narrower and a suggestion diff stops fitting
export const RAIL_ASK = 480;      // floor while a card is up (the dag-generator rule)
export const RAIL_DEFAULT = 340;
const COLLAPSED_W = 34;

// The whole geometry decision, kept pure and out of the DOM so the rule that
// matters — an ask FLOORS the width, it does not replace it — is testable.
export function railWidth({ width, asksOpen, avail, minMain, min = RAIL_MIN, floor = RAIL_ASK }) {
  const max = Math.max(min, avail - minMain);
  const want = Math.max(width || RAIL_DEFAULT, asksOpen ? floor : 0);
  return Math.min(Math.max(want, min), max);
}

export function mountRail({ host, storageKey, minMain = 340, width: fallback = RAIL_DEFAULT, label = '' }) {
  let prefs = {};
  try { prefs = JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch { prefs = {}; }
  const save = () => { try { localStorage.setItem(storageKey, JSON.stringify(prefs)); } catch { /* private mode */ } };

  let width = prefs.width || fallback;
  let collapsed = !!prefs.collapsed;
  let asksOpen = false;

  host.classList.add('ck-rail');

  const el = (tag, cls, attrs = {}) => Object.assign(document.createElement(tag), attrs, { className: cls });
  const button = (glyph, title, onclick) => {
    const b = el('button', 'ck-rail-btn', { type: 'button', textContent: glyph, title, onclick });
    b.setAttribute('aria-label', title);
    return b;
  };

  const headBadge = el('span', 'ck-rail-badge', { hidden: true });
  const foldBtn = button('⟩', 'Collapse the rail', collapse);
  const head = el('div', 'ck-rail-head');
  head.append(headBadge, foldBtn);

  // The folded face. The badge lives here too: a collapse that hid the count
  // would make the session's cards silent, which is the one thing a rail that
  // can disappear must never do.
  const stripBadge = el('span', 'ck-rail-badge', { hidden: true });
  const strip = el('div', 'ck-rail-strip');
  strip.append(button('⟨', 'Expand the rail', expand), stripBadge);
  if (label) strip.append(el('span', 'ck-rail-label', { textContent: label }));

  const grip = makeGrip();
  host.prepend(head);
  host.append(grip, strip);

  // ---- sizing ----

  // Recomputed rather than remembered: a window the reader has since shrunk can
  // otherwise strand a rail across most of the surface.
  function maxAvail() {
    const row = host.parentNode;
    return row && row.clientWidth ? row.clientWidth : window.innerWidth;
  }

  function applyWidth() {
    if (collapsed) { host.style.setProperty('--ck-rail-w', COLLAPSED_W + 'px'); return; }
    const px = railWidth({
      width, asksOpen,
      avail: maxAvail(),
      minMain: typeof minMain === 'function' ? minMain() : minMain,
    });
    host.style.setProperty('--ck-rail-w', px + 'px');
  }

  // The reader's own width, stored separately from whatever the ask floor is
  // currently forcing — otherwise a drag while a card is up would silently
  // adopt 480 as their preference the moment the card cleared.
  function setWidth(px) {
    width = Math.min(Math.max(Math.round(px), RAIL_MIN),
      Math.max(RAIL_MIN, maxAvail() - (typeof minMain === 'function' ? minMain() : minMain)));
    prefs.width = width;
    applyWidth();
  }

  // A separator, so it is in the tab order and answers to the arrow keys — a
  // drag handle nobody can reach from the keyboard is a control only half the
  // room has.
  function makeGrip() {
    const g = el('div', 'ck-rail-grip');
    g.setAttribute('role', 'separator');
    g.setAttribute('aria-orientation', 'vertical');
    g.setAttribute('aria-label', 'Resize the rail');
    g.tabIndex = 0;
    // Stepped from the stored width, never from the measured one. The rail eases
    // into a new width over .14s, so a held arrow key would read the same
    // pre-transition rect ten times and move 24px total; and while a card is up
    // the measured width is the ASK FLOOR, so stepping off it would quietly
    // adopt 480 as his preference.
    g.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowLeft' ? 24 : (e.key === 'ArrowRight' ? -24 : 0);
      if (!step) return;
      e.preventDefault();
      if (collapsed) { expand(); return; }
      setWidth(width + step);
      save();
    });

    // Width measured from the rail's outer edge rather than accumulated from the
    // pointer's delta, so the grip stays under the cursor even after the clamp
    // has stopped the rail from following it.
    const move = (e) => setWidth(host.getBoundingClientRect().right - e.clientX);
    const stop = () => {
      g.classList.remove('is-dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      save();
    };
    // Listeners on the window for the duration of the drag rather than pointer
    // capture on the grip: capture is the tidier API but throws if the pointer
    // is not active by the time it is asked for, and a resize that dies silently
    // on the first move is worse than a pair of listeners.
    g.addEventListener('pointerdown', (e) => {
      if (e.button) return;                       // primary button only
      e.preventDefault();
      if (collapsed) { expand(); return; }        // grabbing a folded rail unfolds it
      g.classList.add('is-dragging');
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', stop);
      window.addEventListener('pointercancel', stop);
    });
    return g;
  }

  // ---- collapse ----

  function paintFold() {
    host.classList.toggle('is-collapsed', collapsed);
    foldBtn.setAttribute('aria-expanded', String(!collapsed));
    applyWidth();
  }
  function collapse() { if (collapsed) return; collapsed = true; prefs.collapsed = true; save(); paintFold(); }
  function expand() { if (!collapsed) return; collapsed = false; prefs.collapsed = false; save(); paintFold(); }

  const onResize = () => applyWidth();
  window.addEventListener('resize', onResize);
  paintFold();

  return {
    setOpen(open) {
      asksOpen = !!open;
      host.classList.toggle('is-asks-open', asksOpen);
      if (asksOpen) expand();
      else applyWidth();
    },
    setBadge(n) {
      for (const b of [headBadge, stripBadge]) {
        b.textContent = String(n || '');
        b.hidden = !n;
      }
    },
    collapse, expand,
    toggle: () => (collapsed ? expand() : collapse()),
    isCollapsed: () => collapsed,
    applyWidth,
    destroy() {
      window.removeEventListener('resize', onResize);
      head.remove(); grip.remove(); strip.remove();
      host.classList.remove('ck-rail', 'is-collapsed', 'is-asks-open');
      host.style.removeProperty('--ck-rail-w');
    },
  };
}
