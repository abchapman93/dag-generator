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
// Live app (the collab bus — see skills/dag-generator/SKILL.md, Path C):
//   dag draft   --title "Adherence" --formula "..."   # a claude-* draft, never Alec's DAG
//   dag open    <slug> | --title T <input>             # start the app, open ?config=<slug>
//   dag suggest --formula "..." [--rationale R]        # a dag-patch card against the open DAG
//
// Input (one of): --formula S | --dagitty S | --tikz S | --in FILE [--from T] | stdin
// Formats: json formula dagitty tex svg html png pdf
// Flags:   --style informal|manuscript  --wrap picture|standalone|figure
//          --layout / --no-layout  --compile  -o FILE

import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as formula from '../engine/formula.mjs';
import * as dagitty from '../engine/dagitty.mjs';
import * as tikz from '../engine/tikz.mjs';
import { layout } from '../engine/layout.mjs';
import { toSVG } from '../engine/svg.mjs';
import { toHTML } from '../engine/html.mjs';
import { validate } from '../engine/model.mjs';
import { diffModels, describeOps, NODE_FIELDS, EDGE_FIELDS } from '../engine/patch.mjs';

const run = promisify(execFile);
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const TEXT_FORMATS = new Set(['json', 'formula', 'dagitty', 'tex', 'svg', 'html']);
const BINARY_FORMATS = new Set(['png', 'pdf']);

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const key = t.slice(2);
      if (['layout', 'no-layout', 'compile', 'positions', 'print', 'dry-run'].includes(key)) a[key] = true;
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

// ---- live app: the server's bus-facing routes ----

const hasInput = (a) => a.formula != null || a.dagitty != null || a.tikz != null || a.in != null;
const inputKind = (a) => (a.formula != null ? 'formula' : a.dagitty != null ? 'dagitty' : a.tikz != null ? 'tikz'
  : a.in != null ? (a.from || 'file') : (a.from || 'formula'));

function appUrl(a) {
  const u = a.url || process.env.DAG_GENERATOR_URL || `http://127.0.0.1:${process.env.DAG_GENERATOR_PORT || 4180}/`;
  return u.endsWith('/') ? u : `${u}/`;
}

async function api(a, method, path, body) {
  let res;
  try {
    res = await fetch(`${appUrl(a)}dag/api${path}`, {
      method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
  } catch { return { status: 0, body: null }; }
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function ensureServer(a) {
  if ((await api(a, 'GET', '/state')).status === 200) return;
  if (a.url || process.env.DAG_GENERATOR_URL) fail(`no dag-generator at ${appUrl(a)}`);
  await run(join(REPO, 'bin', 'dag-generator'), ['--start'], { env: { ...process.env, DAG_GENERATOR_DIR: REPO } });
}

async function draft(a) {
  if (!a.title) fail('draft needs --title');
  const model = await loadModel(a);
  const { status, body } = await api(a, 'PUT', '/claude/configs', { title: a.title, model });
  if (status === 409) fail(`${body.detail} (with it open: dag suggest <input>)`);
  if (status !== 200) fail(status ? (body?.error || `server said ${status}`) : `no dag-generator at ${appUrl(a)} (dag open starts it)`);
  process.stderr.write(`${body.replaced ? 'replaced' : 'wrote'} draft ${body.slug}
`);
  return body;
}

async function openCmd(a) {
  await ensureServer(a);
  let slug = a._[1];
  if (hasInput(a)) slug = (await draft(a)).slug;
  const url = slug ? `${appUrl(a)}?config=${encodeURIComponent(slug)}` : appUrl(a);
  if (!a.print) await run('open', [url]).catch(() => {});
  process.stdout.write(`${url}\n`);
}

// A dag-patch card against the DAG on screen. The suggestion is compared with
// what the page last reported (GET /current), so the card's ops are relative to
// exactly what Alec sees. A formula or dagitty input carries structure only, so
// only nodes and edges are compared — never labels, roles, styles or colours
// Alec has set by hand.
async function suggest(a) {
  const cur = await api(a, 'GET', '/current');
  if (cur.status !== 200) fail(cur.status ? cur.body?.error : `no dag-generator at ${appUrl(a)}`);
  const base = cur.body.model;
  const want = await loadModel(a);
  const structural = ['formula', 'dagitty'].includes(inputKind(a));
  const ops = diffModels(base, want, {
    nodeFields: structural ? [] : NODE_FIELDS,
    edgeFields: structural ? [] : EDGE_FIELDS,
    positions: !!a.positions,
  });
  if (!ops.length) fail('no changes: the suggestion matches the DAG on screen');
  for (const d of describeOps(ops, base)) process.stderr.write(`  ${d.sign} ${d.text}\n`);

  const slug = cur.body.slug ?? null;
  const payload = { type: 'dag-patch', subject: `dag:${slug || 'scratch'}`, base_slug: slug, ops };
  if (a.rationale) payload.rationale = a.rationale;
  if (a['dry-run']) { process.stdout.write(JSON.stringify(payload, null, 2) + '\n'); return; }

  const script = process.env.OUTBOUND_PY || join(homedir(), '.claude', 'skills', 'session-bridge', 'scripts', 'outbound.py');
  const prompt = a.prompt || `Suggested change to ${cur.body.name || slug || 'the open DAG'} (${ops.length} op${ops.length === 1 ? '' : 's'})`;
  const args = [script, 'emit', '--prompt', prompt, '--option', 'Accept', '--option', 'Reject',
    '--target', 'dag-generator', '--payload', JSON.stringify(payload)];
  if (a.channel) args.push('--channel', a.channel);
  const { stdout } = await run('python3', args);
  process.stdout.write(stdout);
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const cmd = a._[0] || 'render';
  if (cmd === 'help' || a.help) { process.stdout.write(HELP); return; }
  if (cmd === 'draft') { const d = await draft(a); process.stdout.write(`${d.url || d.slug}\n`); return; }
  if (cmd === 'open') return openCmd(a);
  if (cmd === 'suggest') return suggest(a);
  if (!['render', 'convert'].includes(cmd)) fail(`unknown command '${cmd}' (try: render, convert, draft, open, suggest)`);

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

Live app (http://127.0.0.1:4180/ unless --url or DAG_GENERATOR_URL):
  dag draft   --title T <input>              a claude-* draft (refused once Alec edits it)
  dag open    [slug] [--title T <input>]     start the app and open a DAG (--print: URL only)
  dag suggest <input> [--rationale R] [--channel C] [--prompt P] [--positions] [--dry-run]
              a dag-patch card against the open DAG (Accept applies it as one undo step)
`;

main().catch((e) => fail(e.message));
