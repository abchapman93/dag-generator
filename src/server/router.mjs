// Express router exposing the LaTeX-compile seam. Mounted at /dag by the
// standalone server; can be re-mounted under /analysis/api/.../dag when the tool
// is embedded in research-lounge (the frontend does all engine work client-side,
// so this is the only server surface it needs).

import express from 'express';
import { detectTools, compile } from './compile.mjs';
import { listConfigs, readConfig, writeConfig, deleteConfig } from './configs.mjs';
import { emitPointAt } from './pointat.mjs';

const MIME = { pdf: 'application/pdf', svg: 'image/svg+xml', png: 'image/png' };

export function createRouter() {
  const r = express.Router();

  r.get('/api/tools', async (_req, res) => {
    try { res.json(await detectTools()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- saved-DAG registry ----
  r.get('/api/configs', async (_req, res) => {
    try { res.json(await listConfigs()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  r.get('/api/configs/:slug', async (req, res) => {
    try { res.json(await readConfig(req.params.slug)); }
    catch { res.status(404).json({ error: 'not found' }); }
  });
  r.put('/api/configs', async (req, res) => {
    const { name, model, slug } = req.body || {};
    if (!model || !Array.isArray(model.nodes)) return res.status(400).json({ error: 'missing model' });
    try { res.json(await writeConfig({ name, model, slug })); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  r.delete('/api/configs/:slug', async (req, res) => {
    try { await deleteConfig(req.params.slug); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
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

  // POST { handle, label?, style?, source?, png? } -> writes a point-at signal to
  // the web-context bus (~/.claude/web-context/signals/) for /session-attach.
  r.post('/api/point-at', async (req, res) => {
    const { handle, handles } = req.body || {};
    if (!handle && !(Array.isArray(handles) && handles.length)) return res.status(400).json({ error: 'missing handle' });
    try { res.json(await emitPointAt(req.body)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  return r;
}
