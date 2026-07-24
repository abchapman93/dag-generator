// Point-at bus writer. When Alec clicks a node/edge on the canvas and points at
// it, the browser POSTs the resolved grammar handle (+ an optional PNG crop)
// here, and this writes a "signal" to the web-context bus so a running Claude
// Code session can collect what he pointed at (/session-attach).
//
// The bus is a filesystem contract, not an API — one JSON file per signal in
// ~/.claude/web-context/signals/, schema documented in
// ~/.claude/skills/session-bridge/references/attach.md. We write the JSON
// directly (a sanctioned alternative to shelling `signals.py emit`) because this
// server is already doing filesystem work: it also writes the crop PNG. Keeping
// it in JS also honours the engine/compile invariant — no child_process here.

import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Override for tests (mirrors configs.mjs's DAG_GENERATOR_DATA).
const WEB_CONTEXT = process.env.DAG_GENERATOR_WEBCTX || join(homedir(), '.claude', 'web-context');
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PNG_PREFIX = 'data:image/png;base64,';

// Flatten a surface-supplied string to one line so it can't break out of its
// quotation when a session reads it (mirrors signals.py's one_line).
const oneLine = (s, limit = 300) => (String(s || '').split(/\s+/).filter(Boolean).join(' ').slice(0, limit)) || null;
// TeX label -> plain text for a readable title ($severe$ -> severe).
const stripTex = (s) => String(s || '').replace(/[$\\{}]/g, '').trim();

// Timestamped + collision-resistant, and sorts chronologically as a filename
// (matches signals.py.new_signal_id: YYYYMMDDTHHMMSSZ-<4 hex>).
function newSignalId() {
  const t = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${t}-${randomBytes(2).toString('hex')}`;
}

// Temp-then-rename: a /session-attach listener polls the signal dir in a loop; a
// plain write would let it read a truncated file. os.rename is atomic in-fs.
async function writeAtomic(path, data) {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

// One-element title: `@node:severe — severe (node, leaf)`.
function oneTitle({ handle, label, style }) {
  const kindWord = handle.startsWith('@edge:') ? 'edge' : 'node';
  const meta = [label ? `— ${stripTex(label)}` : '', `(${[kindWord, style].filter(Boolean).join(', ')})`];
  return [handle, ...meta].filter(Boolean).join(' ');
}

// Emit one point-at signal covering one or more selected elements. Pass `handles`
// (an array of {handle,label,style}) for multi-select, or the singular `handle`
// shorthand; `png` is an optional data-URL crop (the union bbox for multi). Returns
// a small receipt for the UI status line.
export async function emitPointAt({ handles, handle, label, style, source, png } = {}) {
  let list = Array.isArray(handles) ? handles : (handle ? [{ handle, label, style }] : []);
  list = list.map((h) => ({ handle: oneLine(h.handle, 120), label: h.label, style: h.style })).filter((h) => h.handle);
  if (!list.length) throw new Error('handle is required');
  const signalDir = join(WEB_CONTEXT, 'signals');
  await mkdir(signalDir, { recursive: true });
  const signalId = newSignalId();

  // Optional crop: write it and point context_path at it, so /session-attach
  // surfaces the visual on collect — this extends context_path (documented for
  // framed text) to carry an image, which is the show-don't-tell payoff.
  let contextPath = null;
  if (typeof png === 'string' && png.startsWith(PNG_PREFIX)) {
    const cropDir = join(WEB_CONTEXT, 'point-at');
    await mkdir(cropDir, { recursive: true });
    contextPath = join(cropDir, `${signalId}.png`);
    await writeAtomic(contextPath, Buffer.from(png.slice(PNG_PREFIX.length), 'base64'));
  }

  const title = list.length === 1
    ? oneTitle(list[0])
    : `${list.map((h) => h.handle).join(', ')} (${list.length} elements)`;
  const signal = {
    signal_id: signalId,
    kind: 'dag-point-at',
    source: oneLine(source) || 'http://127.0.0.1:4180/',
    created_at: new Date().toISOString(),
    title: oneLine(title),
    note: null,
    session_id: null,
    cwd_hint: REPO_ROOT,
    contract_url: null,
    state_url: null,
    context_path: contextPath,
    consumed_at: null,
    consumed_by: null,
  };
  await writeAtomic(join(signalDir, `${signalId}.json`), JSON.stringify(signal, null, 2) + '\n');
  return { signal_id: signalId, handle: list[0].handle, handles: list.map((h) => h.handle), title: signal.title, crop: contextPath };
}
