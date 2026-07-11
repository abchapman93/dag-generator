#!/usr/bin/env node
// dag — deterministic CLI for the dag-generator engine. Turns a formula / dagitty
// / tikz / json model into any export format. This is what the Claude skill calls
// so DAGs are rendered by the engine, never hand-drawn.
//
//   dag render --formula "A ~ L, Y ~ A + L" --style manuscript --format tex
//   dag render --in model.json --format svg -o fig.svg
//   dag render --dagitty "$(cat g.txt)" --format pdf -o fig.pdf      # compiles
//   dag convert --formula "Y ~ A + L" --to dagitty
//
// Input (one of): --formula S | --dagitty S | --tikz S | --in FILE [--from T] | stdin
// Formats: json formula dagitty tex svg html png pdf
// Flags:   --style informal|manuscript  --wrap picture|standalone|figure
//          --layout / --no-layout  --compile  -o FILE

import { readFile, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import * as formula from '../engine/formula.mjs';
import * as dagitty from '../engine/dagitty.mjs';
import * as tikz from '../engine/tikz.mjs';
import { layout } from '../engine/layout.mjs';
import { toSVG } from '../engine/svg.mjs';
import { toHTML } from '../engine/html.mjs';
import { validate } from '../engine/model.mjs';

const TEXT_FORMATS = new Set(['json', 'formula', 'dagitty', 'tex', 'svg', 'html']);
const BINARY_FORMATS = new Set(['png', 'pdf']);

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const key = t.slice(2);
      if (['layout', 'no-layout', 'compile'].includes(key)) a[key] = true;
      else a[key] = argv[++i];
    } else if (t === '-o') a.o = argv[++i];
    else a._.push(t);
  }
  return a;
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function loadModel(a) {
  let model, flags = [];
  if (a.formula != null) ({ model, flags } = formula.parse(a.formula));
  else if (a.dagitty != null) ({ model, flags } = dagitty.parse(a.dagitty));
  else if (a.tikz != null) ({ model, flags } = tikz.parse(a.tikz));
  else if (a.in != null) {
    const text = await readFile(a.in, 'utf8');
    const from = a.from || detectFrom(a.in, text);
    ({ model, flags } = parseAs(from, text));
  } else if (!process.stdin.isTTY) {
    const text = await readStdin();
    ({ model, flags } = parseAs(a.from || 'formula', text));
  } else {
    fail('no input: pass --formula / --dagitty / --tikz / --in FILE, or pipe via stdin');
  }

  if (a.style) model.meta.style = a.style;
  const noCoords = model.nodes.every((n) => n.x === 0 && n.y === 0);
  if ((a.layout || noCoords) && !a['no-layout']) layout(model);

  for (const f of flags) process.stderr.write(`⚠ line ${f.line}: ${f.why}\n`);
  const v = validate(model);
  for (const w of v.warnings) process.stderr.write(`⚠ ${w}\n`);
  if (!v.ok) fail('invalid model:\n  ' + v.errors.join('\n  '));
  return model;
}

function detectFrom(path, text) {
  const ext = extname(path).toLowerCase();
  if (ext === '.json') return 'json';
  if (ext === '.tex') return 'tikz';
  if (/^\s*(dag|graph|pdag|mag)\b[^{]*\{/.test(text)) return 'dagitty';
  if (/\\node\[|\\begin\{tikzpicture\}/.test(text)) return 'tikz';
  return 'formula';
}

function parseAs(from, text) {
  switch (from) {
    case 'json': return { model: JSON.parse(text), flags: [] };
    case 'dagitty': return dagitty.parse(text);
    case 'tikz': return tikz.parse(text);
    case 'formula': return formula.parse(text);
    default: fail(`unknown input type '${from}'`);
  }
}

async function render(model, format, a) {
  const style = model.meta.style || 'informal';
  const wrap = a.wrap || 'picture';
  switch (format) {
    case 'json': return JSON.stringify(model, null, 2);
    case 'formula': return formula.emit(model);
    case 'dagitty': return dagitty.emit(model);
    case 'tex': return tikz.emit(model, { wrap });
    case 'html': return toHTML(model, { style });
    case 'svg':
      if (a.compile) return (await import('../server/compile.mjs')).compile(model, 'svg');
      return toSVG(model, { style });
    case 'png': {
      const c = await import('../server/compile.mjs');
      if (a.compile) return c.compile(model, 'png');
      return c.svgToPng(toSVG(model, { style }), { zoom: 2 });
    }
    case 'pdf': return (await import('../server/compile.mjs')).compile(model, 'pdf');
    default: fail(`unknown format '${format}'`);
  }
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const cmd = a._[0] || 'render';
  if (cmd === 'help' || a.help) { process.stdout.write(HELP); return; }
  if (!['render', 'convert'].includes(cmd)) fail(`unknown command '${cmd}' (try: render, convert)`);

  const format = a.to || a.format || 'svg';
  if (!TEXT_FORMATS.has(format) && !BINARY_FORMATS.has(format)) fail(`unknown format '${format}'`);

  const model = await loadModel(a);
  const out = await render(model, format, a);

  if (Buffer.isBuffer(out)) {
    if (!a.o) fail(`format '${format}' is binary — pass -o FILE`);
    await writeFile(a.o, out);
    process.stderr.write(`wrote ${a.o} (${out.length} bytes)\n`);
  } else if (a.o) {
    await writeFile(a.o, out, 'utf8');
    process.stderr.write(`wrote ${a.o}\n`);
  } else {
    process.stdout.write(out.endsWith('\n') ? out : out + '\n');
  }
}

function fail(msg) { process.stderr.write(`dag: ${msg}\n`); process.exit(1); }

const HELP = `dag — causal DAG/SWIG engine CLI

  dag render  --formula "A ~ L, Y ~ A + L" --style manuscript --format tex
  dag render  --in model.json --format svg -o fig.svg
  dag render  --dagitty "$(cat g.txt)" --format pdf -o fig.pdf
  dag convert --formula "Y ~ A + L" --to dagitty

Input : --formula S | --dagitty S | --tikz S | --in FILE [--from json|formula|dagitty|tikz] | stdin
Format: json formula dagitty tex svg html png pdf
Flags : --style informal|manuscript  --wrap picture|standalone|figure
        --layout | --no-layout   --compile (LaTeX SVG/PNG)   -o FILE
`;

main().catch((e) => fail(e.message));
