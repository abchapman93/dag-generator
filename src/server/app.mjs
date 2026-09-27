// The standalone dag-generator app: the page, the pure engine modules for
// direct in-browser ESM import, the vendored collab kit, and the /dag router.
// A factory so tests can point it at a throwaway web-context and config dir.

import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createRouter } from './router.mjs';
import { createConfigs, defaultConfigsDir } from './configs.mjs';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(SRC, '..');
const KIT = join(REPO, 'kit', 'vendor');

export function defaultWebContext() {
  return process.env.DAG_GENERATOR_WEBCTX || process.env.COLLAB_WEBCTX || join(homedir(), '.claude', 'web-context');
}

export function createApp({ webContext = defaultWebContext(), configsDir = defaultConfigsDir(), baseUrl = null } = {}) {
  const app = express();
  app.use(express.json({ limit: '16mb' }));   // a model plus a 2x PNG crop

  // Dev server: never let the browser cache modules/assets, so edits show on reload
  // (ES-module imports are otherwise cached aggressively).
  const noStore = { setHeaders: (res) => res.setHeader('Cache-Control', 'no-store') };

  app.use('/engine', express.static(join(SRC, 'engine'), noStore));
  app.use('/dag', createRouter({ webContext, configs: createConfigs({ dir: configsDir }), baseUrl, cwdHint: REPO }));
  // The kit's frontend modules, plus the one root module they import.
  app.get('/kit/asks.mjs', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('application/javascript').sendFile(join(KIT, 'asks.mjs'));
  });
  app.use('/kit', express.static(join(KIT, 'frontend'), noStore));
  // Frontend (registered last so /engine, /dag and /kit win).
  app.use('/', express.static(join(SRC, 'frontend'), noStore));
  return app;
}
