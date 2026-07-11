// Standalone dag-generator server. Serves the frontend, serves the pure engine
// modules for direct in-browser ESM import, and mounts the compile router.

import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRouter } from './router.mjs';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT || 4180;

const app = express();
app.use(express.json({ limit: '4mb' }));

// Dev server: never let the browser cache modules/assets, so edits show on reload
// (ES-module imports are otherwise cached aggressively).
const noStore = { setHeaders: (res) => res.setHeader('Cache-Control', 'no-store') };

// Pure engine modules, imported directly by the frontend as ES modules.
app.use('/engine', express.static(join(SRC, 'engine'), noStore));
// Compile seam (LaTeX PDF/SVG/PNG).
app.use('/dag', createRouter());
// Frontend (registered last so /engine and /dag win).
app.use('/', express.static(join(SRC, 'frontend'), noStore));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`dag-generator → http://127.0.0.1:${PORT}/`);
});
