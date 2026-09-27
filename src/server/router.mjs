// dag-generator's server surface: LaTeX compile, the saved-DAG registry, and the
// collab bus (kit). Mounted at /dag by the standalone app (so the page's API is
// /dag/api/*); can be re-mounted elsewhere when the tool is embedded (the
// frontend does all engine work client-side).
//
// The bus binding (collab-lab docs/grammar.md, per-setting bindings):
//   handles  @node:<id> / @edge:<from>-><to>   (src/engine/handles.mjs)
//   context  a PNG crop of the selection, plus the mirror for the whole DAG
//   kinds    dag-generator-* / target `dag-generator`
//   cards    in the rail; `dag-patch` payloads resolve through /suggestions
//
// Claude writes toward Alec's DAG through exactly one door, and only on his
// click: POST /suggestions/:id/resolve, which validates a patch card and
// records the answer — the page applies the ops to its own model. A session's
// other write is its own claude-* drafts (PUT /claude/configs), never his.

import express from 'express';
import { detectTools, compile } from './compile.mjs';
import { createConfigs } from './configs.mjs';
import { createMirror } from './mirror.mjs';
import { createSignalWriter } from '../../kit/vendor/server/signals.mjs';
import { createOutbound } from '../../kit/vendor/server/outbound.mjs';
import { createChannels } from '../../kit/vendor/server/channels.mjs';
import { staleBySubject } from '../../kit/vendor/asks.mjs';

export const SURFACE = 'dag-generator';   // kind prefix AND --target slug

const MIME = { pdf: 'application/pdf', svg: 'image/svg+xml', png: 'image/png' };

// TeX label -> plain text for a readable signal title ($severe$ -> severe).
const stripTex = (s) => String(s || '').replace(/[$\\{}]/g, '').trim();
const q = (v) => (typeof v === 'string' && v) || null;

export function createRouter({ webContext, configs = createConfigs(), baseUrl = null, cwdHint = null } = {}) {
  const r = express.Router();
  const outbound = createOutbound({ webContext });
  const channels = createChannels({ webContext });
  const mirror = createMirror({ rootDir: `${webContext}/mirrors` });
  const signals = createSignalWriter({
    surface: SURFACE,
    webContext,
    defaultSource: baseUrl,
    cwdHint,
    stateUrl: baseUrl ? `${baseUrl}dag/api/state` : null,
  });

  // The DAG on screen, as the page last reported it. In memory only: it is a
  // pointer for /state and the patch-base check, and the mirror is its disk copy.
  let current = null;   // { slug, name, model, version, updated_at }

  r.get('/api/tools', async (_req, res) => {
    try { res.json(await detectTools()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- saved-DAG registry (Alec's writes) ----
  r.get('/api/configs', async (_req, res) => {
    try { res.json(await configs.list()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  r.get('/api/configs/:slug', async (req, res) => {
    try { res.json(await configs.read(req.params.slug)); }
    catch { res.status(404).json({ error: 'not found' }); }
  });
  r.put('/api/configs', async (req, res) => {
    const { name, model, slug } = req.body || {};
    if (!model || !Array.isArray(model.nodes)) return res.status(400).json({ error: 'missing model' });
    try { res.json(await configs.write({ name, model, slug })); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  r.delete('/api/configs/:slug', async (req, res) => {
    try { await configs.remove(req.params.slug); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- Claude's own drafts ----
  // No slug parameter exists: the slug is minted from the title inside
  // configs.writeClaudeDraft, so this route cannot be aimed at Alec's DAGs.
  r.put('/api/claude/configs', async (req, res) => {
    const { title, model } = req.body || {};
    if (!title || !String(title).trim()) return res.status(400).json({ error: 'missing title' });
    if (!model || !Array.isArray(model.nodes)) return res.status(400).json({ error: 'missing model' });
    try {
      const out = await configs.writeClaudeDraft({ title, model });
      res.json({ ...out, url: baseUrl ? `${baseUrl}?config=${encodeURIComponent(out.slug)}` : null });
    } catch (e) {
      if (e.code === 'EDITED') return res.status(409).json({ error: 'edited', detail: e.message, slug: e.slug });
      res.status(e.code === 'NAMESPACE' ? 500 : 400).json({ error: e.message });
    }
  });

  // POST { model, format: 'pdf'|'svg'|'png' } -> compiled bytes, or a JSON error.
  r.post('/api/compile', async (req, res) => {
    const { model, format = 'pdf' } = req.body || {};
    if (!model || !Array.isArray(model.nodes)) return res.status(400).json({ error: 'missing model' });
    try {
      const buf = await compile(model, format);
      res.type(MIME[format] || 'application/octet-stream').send(buf);
    } catch (e) {
      res.status(e.code === 'NO_LATEX' ? 501 : 500).json({ error: e.message, code: e.code || null });
    }
  });

  // ---- the open DAG: pointer + mirror ----
  // The page reports what is on screen (debounced). Not a save: Alec's saved
  // configs are written only by PUT /configs.
  r.put('/api/current', async (req, res) => {
    const { slug = null, name = null, model } = req.body || {};
    if (!model || !Array.isArray(model.nodes)) return res.status(400).json({ error: 'missing model' });
    try {
      const m = await mirror.write({ slug, name, model, sourcePath: slug ? configs.pathOf(slug) : null });
      current = { slug, name, model, version: m.version, updated_at: new Date().toISOString() };
      res.json({ version: m.version, mirror: m.dir });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  r.get('/api/current', (_req, res) => {
    if (!current) return res.status(404).json({ error: 'no DAG reported yet — is the page open?' });
    res.json(current);
  });

  // Answers with nothing open too — "no page has reported" is what a collecting
  // session needs to be told.
  r.get('/api/state', async (req, res) => {
    const pending = await outbound.listAsks({ target: SURFACE, channel: q(req.query.channel) });
    res.json({
      surface: SURFACE,
      current: current && {
        slug: current.slug, name: current.name, version: current.version, updated_at: current.updated_at,
        nodes: current.model.nodes.length, edges: current.model.edges.length,
      },
      mirror: current ? mirror.dirFor(current.slug) : null,
      configs_dir: configs.dir,
      pending_asks: pending.length,
    });
  });

  // ---- bus: one door for every human->session payload ----
  // point-at (handles + crop), message (note), ping (nothing), answer
  // (in_reply_to). `comment` is an in_reply_to that does NOT stamp the ask:
  // talking about a card is not resolving it.
  r.post('/api/signal', async (req, res) => {
    const { handles, note, png, in_reply_to: inReplyTo, option_id: optionId, comment, channel, source } = req.body || {};
    const list = (Array.isArray(handles) ? handles : []).map((h) => ({
      handle: h.handle,
      label: stripTex(h.label),
      kind: [String(h.handle || '').startsWith('@edge:') ? 'edge' : 'node', h.style].filter(Boolean).join(', '),
    }));
    try {
      const receipt = await signals.emitSignal({ handles: list, note, png, in_reply_to: inReplyTo, channel: q(channel), source });
      if (inReplyTo && !comment) {
        const ask = await outbound.answerAsk(inReplyTo, { answer: note, optionId: optionId || null }).catch(() => null);
        receipt.answered = ask ? ask.ask_id : null;
      }
      res.json(receipt);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // A BARE ARRAY (the kit's poll maps over it). Stale marks, never removes.
  r.get('/api/asks', async (req, res) => {
    try {
      const asks = await outbound.listAsks({ target: q(req.query.target) || SURFACE, channel: q(req.query.channel) });
      const stale = staleBySubject(asks);
      res.json(asks.map((a) => ({ ...a, stale: stale.has(a.ask_id) })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Dismiss writes NO signal — a dismissal that emits one is not a dismissal.
  r.post('/api/asks/:askId/dismiss', async (req, res) => {
    const ask = await outbound.dismissAsk(req.params.askId, { reason: req.body?.reason }).catch(() => null);
    if (!ask) return res.status(404).json({ error: 'no such ask' });
    if (ask.answered_at) return res.status(409).json({ error: 'already answered', answer: ask.answer });
    res.json({ dismissed: true, ask_id: ask.ask_id });
  });

  // Resolve a dag-patch card. Validation and the answer happen HERE, before the
  // page touches its model: the page applies the ops only after a 200, so a
  // stale, superseded or wrong-DAG card can never land. Reject needs no
  // authority and skips the guards. First answer wins, as everywhere on the bus.
  r.post('/api/suggestions/:askId/resolve', async (req, res) => {
    const { outcome, note, channel, source } = req.body || {};
    if (outcome !== 'accept' && outcome !== 'reject') return res.status(400).json({ error: 'outcome must be accept or reject' });
    const ask = await outbound.getAsk(req.params.askId);
    if (!ask) return res.status(404).json({ error: 'no such ask' });
    const p = ask.payload;
    if (!p || p.type !== 'dag-patch' || !Array.isArray(p.ops) || !p.ops.length) {
      return res.status(400).json({ error: 'not a dag-patch ask (payload needs type dag-patch and ops)' });
    }
    if (ask.answered_at) return res.status(409).json({ error: 'already answered', answer: ask.answer });
    if (ask.retracted_at) return res.status(409).json({ error: 'retracted', detail: ask.retracted_reason || 'the session withdrew this suggestion' });
    if (outcome === 'accept') {
      if (staleBySubject(await outbound.listAsks({ target: SURFACE })).has(ask.ask_id)) {
        return res.status(409).json({ error: 'superseded', detail: 'a newer suggestion for this DAG is open — resolve that one instead' });
      }
      if ('base_slug' in p && (p.base_slug ?? null) !== (current?.slug ?? null)) {
        return res.status(409).json({ error: 'wrong-dag', detail: `this suggestion is for ${p.base_slug || 'the unsaved DAG'}; open it first` });
      }
    }
    const label = [outcome, String(note || '').trim()].filter(Boolean).join(' — ');
    // The answer rides the ASK'S channel when it has one: a channel-X question
    // must not be answered into channel-Y because the picker moved.
    const receipt = await signals.emitSignal({ note: label, in_reply_to: ask.ask_id, source, channel: ask.channel ?? q(channel) });
    await outbound.answerAsk(ask.ask_id, { answer: label, optionId: outcome }).catch(() => null);
    res.json({ outcome, signal_id: receipt.signal_id });
  });

  // ---- channels, proxied for the picker. Archive only; delete stays with the CLI. ----
  r.get('/api/channels', async (_req, res) => {
    try { res.json(await channels.listChannels()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  r.post('/api/channels', async (req, res) => {
    try { res.json(await channels.createChannel({ name: req.body?.name, note: req.body?.note, by: SURFACE })); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  r.post('/api/channels/:id/archive', async (req, res) => {
    const ch = await channels.archiveChannel(req.params.id);
    if (!ch) return res.status(404).json({ error: 'no such channel' });
    res.json(ch);
  });

  return r;
}
