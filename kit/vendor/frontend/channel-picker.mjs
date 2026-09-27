// Channel picker — the surface's half of attaching to a channel. A chip shows
// which scoped feed this tab is on; the dropdown lists active channels (from
// the host's `GET ${basePath}/channels`), creates new ones, and archives the
// current one. The selected id rides on every signal the page emits and on
// the ask poll, which is what keeps two concurrent sessions out of each
// other's traffic.
//
// The unchanneled state is a real state, not an error: it is byte-for-byte
// the pre-channel behavior (signals land unscoped, every channel's listener
// ignores them, an unscoped listener sees them). The chip renders it muted
// and labelled "broadcast" so legacy mode is never invisible.
//
// No delete here — archive only. Delete purges a channel's whole history and
// stays with the CLI (channels.py delete), where meaning it takes typing it.
//
// mountChannelPicker({
//   container,          // element the chip renders into
//   basePath,           // API prefix; GET  `${basePath}/channels`
//                       //             POST `${basePath}/channels` {name}
//                       //             POST `${basePath}/channels/:id/archive`
//   storageKey,         // localStorage key, one per surface ("collab-channel:editor")
//   onChange(id|null),  // fires on every selection change, including the drop
//                       // to broadcast when the stored channel disappears
//   onStatus(kind,msg), // create/archive failures, in the host's own status line
//   pollMs,             // default 10000 — keeps two tabs' chips roughly honest;
//                       // correctness never depends on it (writes are id-keyed)
// }) -> { getChannel(): string|null, setChannel(id, {announce}), refresh(), destroy() }

import { esc } from './ask-cards.mjs';

// "3m" / "2h" / "5d" — enough to tell a live channel from a stale one.
function age(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / (60 * 24))}d`;
}

export function mountChannelPicker({ container, basePath, storageKey, onChange = () => {}, onStatus = () => {}, pollMs = 10000 } = {}) {
  let channels = [];
  let current = (storageKey && localStorage.getItem(storageKey)) || null;
  let validated = false;   // don't render the stored name as live until the list confirms it
  let open = false;
  let timer = null;
  let epoch = 0;   // bumped on every local mutation; see refresh()

  const byId = (id) => channels.find((c) => c.channel_id === id) || null;

  function setChannel(id, { announce = true } = {}) {
    epoch += 1;
    current = id || null;
    if (storageKey) {
      if (current) localStorage.setItem(storageKey, current);
      else localStorage.removeItem(storageKey);
    }
    if (announce) onChange(current);
    render();
  }

  async function fetchChannels() {
    try {
      const res = await fetch(`${basePath}/channels`);
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }   // no server (static/embedded) — the picker is simply off
  }

  // `quiet` is the timer's mode: update the data, but never repaint over an
  // OPEN menu — a background poll must not wipe a half-typed channel name out
  // of the create box (the same half-typed-text rule as ask-cards' diff-skip).
  async function refresh({ quiet = false } = {}) {
    const at = epoch;
    const got = await fetchChannels();
    // A response that predates a local mutation is stale: a refresh armed
    // just before "create" would come back without the new channel and the
    // drop-to-broadcast rule below would revoke a selection made in good
    // faith. Discard it; the next poll sees the true list.
    if (!got || at !== epoch) return;
    channels = got.channels || [];
    validated = true;
    // The stored channel was archived or deleted out from under this tab:
    // drop to broadcast AND say so — a silently wrong chip is how a click
    // ends up on a feed nobody is watching.
    if (current && !byId(current)) setChannel(null);
    else if (!quiet || !open) render();
  }

  let painted = null;   // last rendered markup; identical repaints are skipped
                        // (a quiet poll must not churn the DOM under a click)
  function render() {
    const ch = current ? byId(current) : null;
    const label = ch ? ch.name
      : (current && !validated) ? '…'          // stored id, list not fetched yet
      : 'no channel — broadcast';
    const html = `
      <div class="ck-chan${open ? ' ck-chan-open' : ''}">
        <button class="ck-chan-chip${ch || (current && !validated) ? '' : ' ck-chan-broadcast'}" title="${ch ? 'channel — only a session attached to it hears this tab' : 'unchanneled — any unscoped listener hears this tab'}">
          <span class="ck-chan-dot"></span>${esc(label)}${ch && ch.pending ? ` <span class="ck-chan-pending">${ch.pending}</span>` : ''}
        </button>
        ${open ? `<div class="ck-chan-menu">
          ${channels.map((c) => `
            <button class="ck-chan-row${c.channel_id === current ? ' ck-chan-on' : ''}" data-id="${esc(c.channel_id)}">
              <span class="ck-chan-name">${esc(c.name)}</span>
              <span class="ck-chan-meta">${c.pending ? `${c.pending} pending · ` : ''}${age(c.last_activity) || age(c.created_at)}</span>
              ${c.channel_id === current ? '<span class="ck-chan-arch" title="archive this channel">archive</span>' : ''}
            </button>`).join('')}
          <button class="ck-chan-row${current ? '' : ' ck-chan-on'}" data-id="">
            <span class="ck-chan-name ck-chan-name-broadcast">no channel — broadcast</span>
          </button>
          <div class="ck-chan-new">
            <input class="ck-chan-input" placeholder="new channel…" spellcheck="false">
            <button class="ck-chan-create">create</button>
          </div>
        </div>` : ''}
      </div>`;
    if (html === painted) return;
    painted = html;
    container.innerHTML = html;
  }

  // A create or archive that fails must SAY so. Both used to swallow every
  // error, which is how a host running a server without these routes presents
  // as a button that does nothing at all — no channel, no message, nothing to
  // debug from (Overleaf panel, 2026-07-28: the extension had been reloaded,
  // the bridge process had not, and the 404 was invisible).
  const failed = (verb, res) => onStatus('error', res
    ? `could not ${verb} — the host answered ${res.status}${res.status === 404 ? ' (no such route — is an older server still running?)' : ''}`
    : `could not ${verb} — the host did not answer`);

  async function create(name) {
    const label = name.trim();
    if (!label) return;
    let res;
    try { res = await fetch(`${basePath}/channels`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: label }),
    }); } catch { return failed(`create “${label}”`); }
    if (!res.ok) return failed(`create “${label}”`, res);
    const ch = await res.json();
    channels = [ch, ...channels];
    open = false;
    setChannel(ch.channel_id);
    onStatus('ok', `✓ created “${ch.name}” — this surface is on it now`);
  }

  async function archive(id) {
    let res;
    try { res = await fetch(`${basePath}/channels/${encodeURIComponent(id)}/archive`, { method: 'POST' }); }
    catch { return failed('archive that channel'); }
    if (!res.ok) return failed('archive that channel', res);
    open = false;
    await refresh();   // archived → gone from the active list → drops to broadcast
  }

  container.addEventListener('click', (e) => {
    if (e.target.closest('.ck-chan-chip')) { open = !open; render(); if (open) refresh(); return; }
    if (e.target.closest('.ck-chan-arch')) { archive(current); return; }
    if (e.target.closest('.ck-chan-create')) { create(container.querySelector('.ck-chan-input')?.value || ''); return; }
    const row = e.target.closest('.ck-chan-row');
    if (row) { open = false; setChannel(row.dataset.id || null); }
  });
  container.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList.contains('ck-chan-input')) create(e.target.value);
  });
  // Click anywhere else closes the menu; registered on document so it works,
  // removed in destroy so an unmounted picker doesn't keep a listener alive.
  // A detached target is one of ours: the container handler runs first and
  // re-renders, so by the time the same click bubbles here its target is out
  // of the DOM — contains() would say "outside" and close the menu it just
  // opened.
  const closeOnOutside = (e) => { if (open && e.target.isConnected && !container.contains(e.target)) { open = false; render(); } };
  document.addEventListener('click', closeOnOutside);

  render();
  refresh();
  timer = setInterval(() => refresh({ quiet: true }), pollMs);
  return {
    getChannel: () => current,
    // For a host whose channel lives on the SERVER rather than in the tab (the
    // Overleaf bridge: captures come from a content script that never sees this
    // page, so the bridge holds the feed and the chip follows it). Silent by
    // default — reflecting server truth must not fire onChange and write the
    // value straight back.
    setChannel: (id, { announce = false } = {}) => setChannel(id, { announce }),
    refresh,
    destroy: () => { clearInterval(timer); timer = null; document.removeEventListener('click', closeOnOutside); },
  };
}
