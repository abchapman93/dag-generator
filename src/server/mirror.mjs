// The bus's copy of the DAG on screen, so a session can Read it without being
// sent anything: web-context/mirrors/dag-generator-<slug>/{dag.json,dag.md,dag.svg}.
// An unsaved DAG mirrors as `scratch`.
//
// Derived and disposable — the saved config (or the page, for scratch) is the
// source. The header names the source and the model's content hash, so a stale
// mirror is detectable rather than silently wrong. Same shape as the
// whiteboard's mirror (collab-lab/apps/whiteboard/server/mirror.mjs).

import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

import { versionOf } from '../../kit/vendor/server/doc.mjs';
import * as formula from '../engine/formula.mjs';
import * as dagitty from '../engine/dagitty.mjs';
import * as tikz from '../engine/tikz.mjs';
import { toSVG } from '../engine/svg.mjs';
import { validate } from '../engine/model.mjs';
import { formatHandle } from '../engine/handles.mjs';

export const SCRATCH = 'scratch';

// Last gate before a path join.
const SAFE = /^[a-z0-9][a-z0-9-]{0,79}$/;

async function writeAtomic(path, data) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

const attempt = (fn) => { try { return fn(); } catch (e) { return `(could not emit: ${e.message})`; } };
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|');

export function renderMirrorMd({ name, slug, model, sourcePath, version }) {
  const v = validate(model);
  const lines = [
    '<!--',
    '  MIRROR — a copy. The DAG itself lives at:',
    `    ${sourcePath || '(unsaved — only in the open page)'}`,
    `  model version: ${version}`,
    '  If the source has moved on, this file is stale; read the source.',
    '-->',
    '',
    `# ${name || slug}`,
    '',
    `kind: ${model.meta?.kind || 'dag'} · ${model.nodes.length} nodes · ${model.edges.length} edges`,
    '',
    '## Nodes',
    '',
    '| handle | label | style | role | x | y |',
    '|---|---|---|---|---|---|',
    ...model.nodes.map((n) => `| ${cell(formatHandle({ type: 'node', id: n.id }))} | ${cell(n.label)} | ${n.style || ''} | ${n.role || ''} | ${n.x} | ${n.y} |`),
    '',
    '## Edges',
    '',
    '| handle | style | label |',
    '|---|---|---|',
    ...model.edges.map((e) => `| ${cell(formatHandle({ type: 'edge', from: e.from, to: e.to }))} | ${e.style || ''} | ${cell(e.label)} |`),
    '',
    '## Formula',
    '',
    '```',
    attempt(() => formula.emit(model)),
    '```',
    '',
    '## dagitty',
    '',
    '```',
    attempt(() => dagitty.emit(model)),
    '```',
    '',
    '## TikZ',
    '',
    '```latex',
    attempt(() => tikz.emit(model, { wrap: 'picture' })),
    '```',
    '',
    '## Validation',
    '',
    ...(v.errors.length || v.warnings.length
      ? [...v.errors.map((e) => `- error: ${e}`), ...v.warnings.map((w) => `- warning: ${w}`)]
      : ['- ok']),
    '',
  ];
  return lines.join('\n');
}

export function createMirror({ rootDir }) {
  return {
    dirFor(slug) {
      const s = slug || SCRATCH;
      if (!SAFE.test(s)) throw new Error(`unsafe mirror slug: ${JSON.stringify(s)}`);
      return join(rootDir, `dag-generator-${s}`);
    },

    async write({ slug, name, model, sourcePath = null }) {
      const dir = this.dirFor(slug);
      await mkdir(dir, { recursive: true });
      const body = `${JSON.stringify(model, null, 2)}\n`;
      const version = versionOf(body);
      await writeAtomic(join(dir, 'dag.json'), body);
      await writeAtomic(join(dir, 'dag.md'), renderMirrorMd({ name, slug: slug || SCRATCH, model, sourcePath, version }));
      await writeAtomic(join(dir, 'dag.svg'), attempt(() => toSVG(model, { background: '#ffffff' })));
      return { dir, version };
    },
  };
}
