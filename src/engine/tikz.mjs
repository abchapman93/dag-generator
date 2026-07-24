// Canonical TikZ  <->  model.  This is the round-trippable grammar: emit() and
// parse() are inverses over exactly the constructs below, and parse() FLAGS
// anything outside them rather than silently dropping it. That constraint is
// what makes two-way (code<->canvas) editing reliable.
//
// Grammar (one statement per line):
//   \node[<style>](<id>) at (<x>,<y>) {<label>};
//   \node[<style>, fill=<c>, draw=<c>, text=<c>](<id>) at (<x>,<y>) {<label>};
//   \draw[<style>] (<a>) to (<b>);
//   \draw[<style>] (<a>) to[bend left=<n>] (<b>);     (or `bend right`)
//   \draw[<style>] (<a>) to node[<pos>]{<label>} (<b>);   (labelled edge)
//   \splitbar{<id>};                                   (SWIG node-split bar)
// Recognised preamble/wrapper lines are ignored; everything else is flagged.

import { emptyModel, defaultLabel, NODE_STYLES, EDGE_STYLES } from './model.mjs';
import { formatSwigLabel } from './swig.mjs';

// Inlined named-style block (mirror of tikz/dag-styles.tex) so standalone output
// compiles with no external \input.
export const STYLE_BLOCK = `\\usetikzlibrary{positioning, arrows.meta, fit, backgrounds, decorations.pathreplacing, calc, shapes.geometric}
\\tikzset{
  rv/.style     = {inner sep=2pt, minimum size=6mm},
  cond/.style   = {draw, rectangle, inner sep=3.5pt, minimum size=7mm},
  unobs/.style  = {text=gray!60!black, inner sep=2pt, minimum size=6mm},
  regime/.style = {draw=orange, text=orange, diamond, aspect=1.5, inner sep=1pt, minimum size=6mm},
  fixed/.style  = {text=orange, inner sep=3pt, minimum size=6mm},
  decision/.style = {draw, rounded corners=1pt, inner sep=3.5pt, minimum size=7mm},
  leaf/.style     = {draw=gray!60!black, fill=gray!8, rounded corners=3pt, inner sep=3.5pt, minimum size=7mm},
  leafPos/.style  = {draw=green!55!black, fill=green!12, rounded corners=3pt, inner sep=3.5pt, minimum size=7mm},
  leafNeg/.style  = {draw=red!60!black, fill=red!10, rounded corners=3pt, inner sep=3.5pt, minimum size=7mm},
  causal/.style = {-Latex},
  det/.style    = {-Latex, double, double distance=1pt},
  reads/.style  = {-Latex, orange, dashed},
  cfedge/.style = {-Latex, orange},
  biasing/.style= {-Latex, red!70!black},
  blocked/.style= {-Latex, gray, dashed},
  bidirected/.style = {Latex-Latex, dashed, gray!60!black},
  splitline/.style  = {orange, thick},
}
\\providecommand{\\cfs}{{\\color{orange}s}}
\\providecommand{\\cfarg}[1]{{\\color{orange}#1}}
\\providecommand{\\splitbar}[2]{\\draw[splitline] ($(#1.east)!0.5!(#2.west)+(0,3.5mm)$) -- ($(#1.east)!0.5!(#2.west)+(0,-3.5mm)$);}`;

// ---- emit: model -> canonical TikZ --------------------------------------
export function emit(model, opts = {}) {
  const mode = opts.wrap || 'picture'; // 'picture' | 'standalone' | 'figure'
  const sep = model.meta?.nodeSep || 1;
  const swigStyle = model.meta?.swigStyle || 'superscript';
  const body = [];

  body.push(`\\begin{tikzpicture}[node distance=${10 * sep}mm and ${14 * sep}mm]`);
  for (const n of model.nodes) {
    const sty = [n.style];
    if (n.fill) sty.push(`fill=${n.fill}`);
    if (n.stroke) sty.push(`draw=${n.stroke}`);
    if (n.text) sty.push(`text=${n.text}`);
    body.push(`  \\node[${sty.join(', ')}](${n.id}) at (${fmt(n.x)},${fmt(n.y)}) {${formatSwigLabel(n.label, swigStyle)}};`);
  }
  if (model.swig?.interventions) {
    for (const iv of model.swig.interventions) body.push(`  \\splitbar{${iv.node}}{${iv.regimeLabel}};`);
  }
  for (const e of model.edges) {
    // e.bend's sign convention is fixed by the canvas/SVG renderer (screen-space
    // offset direction), which is mirrored relative to TikZ's own y-up bend
    // left/right — see test/engine.test.mjs for the concrete direction check.
    const bend = e.bend ? `[bend ${e.bend > 0 ? 'right' : 'left'}=${Math.abs(e.bend)}]` : '';
    const lbl = e.label ? ` node${e.labelPos ? `[${e.labelPos}]` : ''}{${e.label}}` : '';
    body.push(`  \\draw[${e.style}] (${e.from}) to${bend}${lbl} (${e.to});`);
  }
  body.push(`\\end{tikzpicture}`);
  const picture = body.join('\n');

  if (mode === 'standalone') {
    return [
      '\\documentclass[tikz,border=6pt]{standalone}',
      STYLE_BLOCK,
      '\\begin{document}',
      picture,
      '\\end{document}',
      '',
    ].join('\n');
  }
  if (mode === 'figure') {
    return [
      '% requires \\input{dag-styles} (or the STYLE_BLOCK) in the preamble',
      '\\begin{figure}[t]',
      '\\centering',
      picture,
      model.meta?.title ? `\\caption{${model.meta.title}}` : '% \\caption{...}',
      '\\end{figure}',
    ].join('\n');
  }
  return picture;
}

function fmt(v) { return (Math.round(v * 100) / 100).toString(); }

// ---- parse: canonical TikZ -> { model, flags } --------------------------
const NODE_RE = /^\\node\s*\[([^\]]+)\]\s*\((\w+)\)\s*at\s*\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)\s*\{([\s\S]*)\}\s*;?$/;
// Groups: 1=styles, 2=from, 3=bend-opts, 4=label-pos-opts, 5=label-braces, 6=to.
// The optional `node[pos]{label}` label sits between `to[bend]` and the target;
// the label braces tolerate up to two levels of nesting (e.g. $S_{ep}$).
const EDGE_RE = /^\\draw\s*\[([^\]]+)\]\s*\((\w+)\)\s*to\b\s*(\[[^\]]*\])?\s*(?:node\s*(\[[^\]]*\])?\s*(\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}))?\s*\((\w+)\)\s*;?$/;
const SPLIT_RE = /^\\splitbar\{(\w+)\}\{(\w+)\}\s*;?$/;
const BEND_RE = /bend\s+(left|right)\s*=?\s*(\d+)?/;

const IGNORE_RE = /^\\(documentclass|usepackage|usetikzlibrary|newcommand|providecommand|renewcommand|input|include|centering|caption|label|begin|end)\b/;

export function parse(text) {
  const model = emptyModel({ meta: { style: 'manuscript' } });
  const flags = [];
  const seen = new Set();

  // Remove comments and brace-balanced \tikzset{...} blocks first.
  const cleaned = stripTikzset(stripComments(text));

  cleaned.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;

    let m;
    if ((m = NODE_RE.exec(line))) {
      const opts = m[1].split(',').map((s) => s.trim()).filter(Boolean);
      const style = opts[0];
      if (!NODE_STYLES.includes(style)) { flags.push({ line: i + 1, why: `unknown node style '${style}'` }); return; }
      if (seen.has(m[2])) { flags.push({ line: i + 1, why: `duplicate node '${m[2]}'` }); return; }
      seen.add(m[2]);
      const label = m[5].trim();
      const node = { id: m[2], label: label || defaultLabel(m[2]), x: parseFloat(m[3]), y: parseFloat(m[4]), style };
      for (const opt of opts.slice(1)) {
        let om;
        if ((om = /^fill\s*=\s*(.+)$/.exec(opt))) node.fill = om[1].trim();
        else if ((om = /^draw\s*=\s*(.+)$/.exec(opt))) node.stroke = om[1].trim();
        else if ((om = /^text\s*=\s*(.+)$/.exec(opt))) node.text = om[1].trim();
        else if (opt === 'draw') { /* bare outline flag, implied by the styled shapes — ignore */ }
        else flags.push({ line: i + 1, why: `unsupported node option '${opt}' (kept, not editable)` });
      }
      model.nodes.push(node);
      return;
    }
    if ((m = EDGE_RE.exec(line))) {
      const style = m[1].split(',')[0].trim();
      if (!EDGE_STYLES.includes(style)) { flags.push({ line: i + 1, why: `unknown edge style '${style}'` }); return; }
      let bend = 0;
      if (m[3]) {
        const b = BEND_RE.exec(m[3]);
        if (b) bend = (b[1] === 'right' ? 1 : -1) * (b[2] ? parseInt(b[2], 10) : 30);
        else flags.push({ line: i + 1, why: `unsupported edge option '${m[3]}' (rendered straight, not editable)` });
      }
      const edge = { from: m[2], to: m[6], style, bend };
      if (m[5] != null) {
        edge.label = m[5].slice(1, -1);            // strip the { }
        if (m[4]) edge.labelPos = m[4].slice(1, -1).trim(); // strip the [ ]
      }
      model.edges.push(edge);
      return;
    }
    if ((m = SPLIT_RE.exec(line))) {
      (model.swig ||= { interventions: [] });
      if (!model.swig.interventions.some((iv) => iv.node === m[1])) {
        model.swig.interventions.push({ node: m[1], regimeLabel: m[2] });
      }
      model.meta.kind = 'swig';
      return;
    }
    if (IGNORE_RE.test(line)) return;

    flags.push({ line: i + 1, why: 'unsupported construct' });
  });

  // Drop edges whose endpoints are missing; flag them.
  model.edges = model.edges.filter((e) => {
    if (seen.has(e.from) && seen.has(e.to)) return true;
    flags.push({ line: '—', why: `edge references missing node (${e.from}->${e.to})` });
    return false;
  });

  return { model, flags };
}

function stripComments(text) {
  // Remove `%` to end of line, but not an escaped \%.
  return text.replace(/(^|[^\\])%.*$/gm, '$1');
}

function stripTikzset(text) {
  // Remove `\tikzset{ ... }` blocks with balanced braces (may span lines).
  let out = '';
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf('\\tikzset', i);
    if (at === -1) { out += text.slice(i); break; }
    out += text.slice(i, at);
    let j = text.indexOf('{', at);
    if (j === -1) { out += text.slice(at); break; }
    let depth = 0;
    for (; j < text.length; j++) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') { depth--; if (depth === 0) { j++; break; } }
    }
    i = j;
  }
  return out;
}
