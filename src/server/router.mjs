// Express router exposing the LaTeX-compile seam. Mounted at /dag by the
// standalone server; can be re-mounted under /analysis/api/.../dag when the tool
// is embedded in research-lounge (the frontend does all engine work client-side,
// so this is the only server surface it needs).

import express from 'express';
import { detectTools, compile } from './compile.mjs';

const MIME = { pdf: 'application/pdf', svg: 'image/svg+xml', png: 'image/png' };

export function createRouter() {
  const r = express.Router();

  r.get('/api/tools', async (_req, res) => {
    try { res.json(await detectTools()); }
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

  return r;
}
