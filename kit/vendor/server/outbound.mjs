// Outbound-ask reader — the return half of the signal bus, generalized from
// dag-generator's src/server/asks.mjs. A running Claude Code session writes an
// ask to ~/.claude/web-context/outbound/ (via the portable `outbound.py emit`);
// a surface polls for it, renders it as a card, and the human's click comes
// back through the ORDINARY inbound door as a signal carrying `in_reply_to`.
// The session has no inbound control channel and can't be pushed to — but the
// surface can poll, and that asymmetry is the whole design.
//
// This is a filesystem contract, not an API: the schema of record lives with
// outbound.py (~/.claude/skills/session-bridge/scripts/), and the two
// implementations must stay in step — the interop test in ../test runs the real
// outbound.py against this reader.
//
// GUARDRAIL (instruction-source boundary): an ask is DATA, not a command to the
// surface. Prompt and option labels are Claude-authored so they're safe to
// render, but this module only ever reads them out and echoes the chosen label
// back. It never evaluates anything from an ask file.

import { readdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, extname } from 'node:path';
import { subjectOf } from '../asks.mjs';

// Preview images ride inline in the poll response, so cap them here as
// outbound.py does on write — a surface polling every 2s must not pull
// megabytes each time.
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp' };

// An ask_id indexes a filename, so refuse anything that isn't one — it arrives
// over HTTP and `../../x` must not walk out of the store.
const SAFE_ID = (id) => typeof id === 'string' && /^[A-Za-z0-9._-]+$/.test(id) && !id.startsWith('.');

// The tmp name is unique per WRITE, not per process: two surfaces in one server
// can stamp the same ask at once, and with a shared tmp name the second rename
// finds its file already moved and throws ENOENT.
async function writeAtomic(path, data) {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

async function readAskFile(path) {
  try {
    const ask = JSON.parse(await readFile(path, 'utf8'));
    return (ask && typeof ask === 'object' && ask.ask_id) ? ask : null;
  } catch { return null; }   // mid-write, malformed, or gone — skip it
}

// Inline an option's preview as a data URI. The page never learns the path: it
// gets pixels or nothing, so a bad path degrades to a text-only option rather
// than leaking a filesystem location into the DOM.
async function inlineImage(path) {
  if (!path) return null;
  const mime = IMAGE_MIME[extname(path).toLowerCase()];
  if (!mime) return null;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_IMAGE_BYTES) return null;
    return `data:${mime};base64,${(await readFile(path)).toString('base64')}`;
  } catch { return null; }
}

// Factory rather than module-level state so a surface (or a test) can point at
// its own store without the dynamic-import dance dag-generator's original needs.
export function createOutbound({ webContext } = {}) {
  const base = webContext || process.env.COLLAB_WEBCTX || join(homedir(), '.claude', 'web-context');
  const dir = join(base, 'outbound');

  // Unanswered asks addressed to this surface (plus untargeted ones), newest
  // first. `target` null on the ask means "any open surface" — the broad case
  // is opt-in, so a session can't splash an ask across unrelated surfaces.
  //
  // `subject` narrows further, to the sub-document the surface is currently
  // showing (see ../asks.mjs). A subject-less ask always passes: it is
  // surface-wide by construction, and filtering it out would hide exactly the
  // card whose author forgot to scope it.
  //
  // `channel` follows the same null-passes rule as target: an unchanneled ask
  // shows on every channel. Deliberately looser than the STRICT rule on the
  // signal side — a hidden ask card is a decision withheld from the person,
  // while a replayed signal is the machine's hazard. The race resolves toward
  // the person.
  async function listAsks({ target = null, subject = null, channel = null } = {}) {
    let names;
    try { names = await readdir(dir); }
    catch { return []; }   // no store yet — no asks, not an error
    const asks = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const ask = await readAskFile(join(dir, name));
      if (!ask || ask.answered_at || ask.retracted_at || ask.dismissed_at) continue;
      if (target !== null && ask.target && ask.target !== target) continue;
      if (subject !== null && subjectOf(ask) && subjectOf(ask) !== subject) continue;
      if (channel !== null && ask.channel && ask.channel !== channel) continue;
      const options = await Promise.all((ask.options || []).map(async (o) => ({
        id: o.id,
        label: o.label,
        image: await inlineImage(o.image),
      })));
      asks.push({
        ask_id: ask.ask_id,
        created_at: ask.created_at,
        prompt: ask.prompt,
        options,
        allow_free_text: ask.allow_free_text !== false,
        target: ask.target ?? null,
        channel: ask.channel ?? null,
        source_session: ask.source_session ?? null,
        // Structured payload (e.g. a suggestion's {before, after}) rides along
        // untouched — data for the surface's renderer, never evaluated.
        payload: ask.payload ?? null,
        // Lifted out of the payload so a surface can scope its stack without
        // digging (and without inventing a third name for it).
        subject: subjectOf(ask),
      });
    }
    asks.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    return asks;
  }

  // One raw ask by id (payload included, answered or not) — what a surface's
  // own resolve endpoint reads before acting on a payload.
  async function getAsk(askId) {
    if (!SAFE_ID(askId)) return null;
    return readAskFile(join(dir, `${askId}.json`));
  }

  // How an ask ended, or 'pending'. Precedence follows the write-side doctrine,
  // not field order: ANSWERED beats RETRACTED beats DISMISSED. The overlap is
  // real rather than theoretical — answerAsk blocks only on answered_at, so a
  // session can retract a card and Alec's already-in-flight click still lands,
  // leaving both stamps on the file. The person's decision is what happened.
  function statusOf(ask) {
    if (ask.answered_at) return 'answered';
    if (ask.retracted_at) return 'retracted';
    if (ask.dismissed_at) return 'dismissed';
    return 'pending';
  }

  // The whole store, for an admin view over the bus — every ask, every surface,
  // every channel, terminal states included.
  //
  // FILTERS ARE EXACT HERE, and that is the deliberate difference from
  // listAsks. listAsks answers "what should this surface show?", so it lets
  // null pass: an untargeted or unchanneled ask appears everywhere, because a
  // hidden card is a decision withheld from the person. This answers "what is
  // in the store?", where the same generosity would be a lie — filtering to
  // target=editor and being handed voice-workshop's unscoped cards would make
  // the index unable to tell you where a card actually lives. An unscoped ask
  // is findable under its own bucket instead.
  //
  // UNDEFINED AND NULL DIFFER for target and channel, because null is a real
  // value there: `undefined` (or omitted) means "don't filter on this", while
  // an explicit `null` means "only asks whose target/channel IS null" — the
  // unscoped bucket. `status` keeps null as "don't filter", since statusOf
  // always returns a string and there is no null-status bucket to ask for.
  //
  // NO IMAGES ARE INLINED. listAsks inlines option previews as data URIs
  // because a surface renders a handful of live cards; this lists the entire
  // history, and inlining there would pull megabytes per page load. Rows carry
  // text and status only — the detail view calls getAsk for the rest.
  async function listAllAsks({ status = null, target, channel,
                               search = null, limit = 100, offset = 0 } = {}) {
    let names;
    try { names = await readdir(dir); }
    catch { return { asks: [], total: 0, counts: {}, targets: [], channels: [] }; }

    const all = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const ask = await readAskFile(join(dir, name));
      if (ask) all.push(ask);
    }

    // The facet lists span the WHOLE store regardless of what is filtered:
    // they populate the filter chrome, which has to keep offering the bucket
    // you just filtered yourself out of.
    const targets = new Set();
    const channels = new Set();
    for (const ask of all) {
      targets.add(ask.target ?? null);
      channels.add(ask.channel ?? null);
    }

    // Everything except `status`, so the status counts below describe the slice
    // being looked at — filter to the editor and the tabs read as the editor's
    // own breakdown, not the store's. Counting before the status filter is the
    // point: a tab has to show what switching to it would reveal.
    const needle = String(search ?? '').trim().toLowerCase();
    const scoped = all.filter((ask) => {
      if (target !== undefined && (ask.target ?? null) !== target) return false;
      if (channel !== undefined && (ask.channel ?? null) !== channel) return false;
      if (!needle) return true;
      const hay = [ask.prompt, ask.answer?.label, ask.retracted_reason,
                   ask.dismissed_reason, ask.ask_id].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(needle);
    });

    const counts = { pending: 0, answered: 0, dismissed: 0, retracted: 0 };
    for (const ask of scoped) counts[statusOf(ask)]++;

    const matches = status === null ? scoped : scoped.filter((ask) => statusOf(ask) === status);
    matches.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));

    const page = matches.slice(offset, offset + limit).map((ask) => ({
      ask_id: ask.ask_id,
      created_at: ask.created_at,
      prompt: ask.prompt,
      status: statusOf(ask),
      target: ask.target ?? null,
      channel: ask.channel ?? null,
      source_session: ask.source_session ?? null,
      subject: subjectOf(ask),
      option_count: (ask.options || []).length,
      // The shape of the payload, never its contents — enough for a row to say
      // "suggestion" without shipping every before/after in the history.
      payload_type: (ask.payload && typeof ask.payload === 'object' && ask.payload.type) || null,
      answered_at: ask.answered_at ?? null,
      answer: ask.answer ?? null,
      retracted_at: ask.retracted_at ?? null,
      retracted_reason: ask.retracted_reason ?? null,
      dismissed_at: ask.dismissed_at ?? null,
      dismissed_reason: ask.dismissed_reason ?? null,
    }));

    return {
      asks: page,
      total: matches.length,
      counts,
      targets: [...targets].sort((a, b) => String(a).localeCompare(String(b))),
      channels: [...channels].sort((a, b) => String(a).localeCompare(String(b))),
    };
  }

  // Stamp an ask answered so the card stops rendering. FIRST ANSWER WINS: an
  // already-answered ask is returned untouched, never overwritten — "any open
  // surface answers it" makes two tabs on the same card the expected case, and
  // without this they'd clobber each other and the session would see which
  // answer arrived last rather than which was clicked first.
  async function answerAsk(askId, { answer, optionId = null } = {}) {
    if (!SAFE_ID(askId)) return null;
    const path = join(dir, `${askId}.json`);
    const ask = await readAskFile(path);
    if (!ask) return null;
    if (ask.answered_at) return ask;
    ask.answered_at = new Date().toISOString();
    ask.answer = { label: String(answer ?? '').trim() || null, option_id: optionId || null };
    await writeAtomic(path, JSON.stringify(ask, null, 2) + '\n');
    return ask;
  }

  // Withdraw an ask the session no longer wants answered. The bus had no such
  // verb until 2026-07-26, and its absence ended a dogfood session: a superseded
  // revision card stayed live and fully writable, Alec answered it, and the
  // stale card's text was written into a document he cares about. A correction
  // sent to chat cannot retract a card — only the store can.
  //
  // ANSWERED WINS OVER RETRACTED, deliberately: if the human clicked before the
  // session withdrew, their decision stands and the session learns what they
  // chose. The race resolves toward the person, not toward the machine.
  async function retractAsk(askId, { reason = null } = {}) {
    if (!SAFE_ID(askId)) return null;
    const path = join(dir, `${askId}.json`);
    const ask = await readAskFile(path);
    if (!ask) return null;
    if (ask.answered_at || ask.retracted_at) return ask;
    ask.retracted_at = new Date().toISOString();
    ask.retracted_reason = String(reason ?? '').trim() || null;
    await writeAtomic(path, JSON.stringify(ask, null, 2) + '\n');
    return ask;
  }

  // Clear a card off the surface without answering it — the human's twin of
  // retractAsk, and SILENT BY CONSTRUCTION: nothing here writes a signal, and
  // no caller should write one alongside it.
  //
  // Why silent, when the obvious implementation is "answer it with the word
  // 'dismissed'". A stack of stale cards is what a dead session leaves behind,
  // and clearing it is housekeeping, not a reply. Answering fakes a decision
  // Alec never made and puts it in the store where a later session reads it as
  // one; emitting a signal fires that fiction at whoever is listening now —
  // typically a NEW session that never wrote the card and has no idea what the
  // burst of "dismissed" refers to. So: a stamp of its own, no signal, and a
  // session that wants to know looks (`outbound.py get`) rather than being told.
  //
  // ANSWERED AND RETRACTED BOTH WIN, for the same reason retraction loses to an
  // answer: a decision already made is not undone by later bookkeeping.
  // Idempotent — an already-dismissed ask is returned untouched.
  async function dismissAsk(askId, { reason = null } = {}) {
    if (!SAFE_ID(askId)) return null;
    const path = join(dir, `${askId}.json`);
    const ask = await readAskFile(path);
    if (!ask) return null;
    if (ask.answered_at || ask.retracted_at || ask.dismissed_at) return ask;
    ask.dismissed_at = new Date().toISOString();
    ask.dismissed_reason = String(reason ?? '').trim() || null;
    await writeAtomic(path, JSON.stringify(ask, null, 2) + '\n');
    return ask;
  }

  return { listAsks, listAllAsks, getAsk, answerAsk, retractAsk, dismissAsk, statusOf };
}
