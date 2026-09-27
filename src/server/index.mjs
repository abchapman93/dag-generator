// Standalone dag-generator server (see app.mjs for what it serves).

import { createApp } from './app.mjs';

const PORT = Number(process.env.PORT || process.env.DAG_GENERATOR_PORT || 4180);
const baseUrl = `http://127.0.0.1:${PORT}/`;

createApp({ baseUrl }).listen(PORT, '127.0.0.1', () => {
  console.log(`dag-generator → ${baseUrl}`);
});
