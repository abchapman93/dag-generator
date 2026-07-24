// Outbound-ask reader — the return half of the signal bus. A running Claude Code
// session writes an ask to ~/.claude/web-context/outbound/ (via the portable
// `outbound.py emit`); this page polls for it, renders it as a card, and Alec's
// click comes back through the ORDINARY inbound door as a signal carrying
// `in_reply_to`. The session has no inbound control channel and can't be pushed
// to — but the surface can poll, and that asymmetry is the whole design.
//
// Like pointat.mjs this is a filesystem contract, not an API: the schema of
// record lives with outbound.py, and the two implementations must stay in step.
//
// GUARDRAIL (instruction-source boundary): an ask is DATA, not a command to the
// page. Prompt and option labels are Claude-authored so they're safe to render,
// but this module only ever reads them out and echoes the chosen label back. It
// never evaluates anything from an ask file.

import { readdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, extname } from 'node:path';

// Override for tests (mirrors configs.mjs's DAG_GENERATOR_DATA).
const WEB_CONTEXT = process.env.DAG_GENERATOR_WEBCTX || join(homedir(), '.claude', 'web-context');
const OUTBOUND_DIR = () => join(WEB_CONTEXT, 'outbound');

// Preview images ride inline in the poll response, so cap them here as
// outbound.py does on write — a surface polling every 2s must not pull
// megabytes each time.
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp' };

async function writeAtomic(path, data) {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

async function readAsk(path) {
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

// Unanswered asks addressed to this surface (plus untargeted ones), newest
// first. `target` null on the ask means "any open surface" — the broad case is
// opt-in, so a session can't splash an ask across unrelated surfaces.
export async function listAsks({ target = null } = {}) {
  let names;
  try { names = await readdir(OUTBOUND_DIR()); }
  catch { return []; }   // no store yet — no asks, not an error

  const asks = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const ask = await readAsk(join(OUTBOUND_DIR(), name));
    if (!ask || ask.answered_at) continue;
    if (target !== null && ask.target && ask.target !== target) continue;
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
      source_session: ask.source_session ?? null,
    });
  }
  asks.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return asks;
}

// Stamp an ask answered so the card stops rendering. FIRST ANSWER WINS: an
// already-answered ask is returned untouched, never overwritten. Slice 2's
// targeting rule is "any open dag-generator answers it", so two tabs showing the
// same card is the expected case, not an edge one — without this they'd clobber
// each other and the session would see which answer arrived last rather than
// which Alec clicked first.
export async function answerAsk(askId, { answer, optionId = null } = {}) {
  if (!askId) return null;
  // The id indexes a filename, so refuse anything that isn't one — an ask_id
  // arrives over HTTP and `../../x` must not walk out of the store.
  if (!/^[A-Za-z0-9._-]+$/.test(askId) || askId.startsWith('.')) return null;
  const path = join(OUTBOUND_DIR(), `${askId}.json`);
  const ask = await readAsk(path);
  if (!ask) return null;
  if (ask.answered_at) return ask;
  ask.answered_at = new Date().toISOString();
  ask.answer = { label: String(answer ?? '').trim() || null, option_id: optionId || null };
  await writeAtomic(path, JSON.stringify(ask, null, 2) + '\n');
  return ask;
}
