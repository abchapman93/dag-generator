// R-style structural-formula DSL  <->  canonical model.
//
//   Structural:   Y ~ A + L,  A ~ L         (RHS `+`-separated parents; `1`/`0` = none)
//   Arrow chains: A -> M -> Y                (equivalent sugar)
//   Labelled edge: S -> abx : "Severe"       (single arrow with a branch label)
//   Bidirected:   U1 <-> U2                  (latent common cause; style `bidirected`)
//   Roles:        exposure: A                outcome: Y
//                 confounder: L1, L2         mediator: M    instrument: Z
//                 unmeasured: U   (alias latent:)   adjusted: X  (conditioning box)
//   Flowchart:    decision: S, C             (branch/test box)
//                 leaf: L    recommend: abx    avoid: noabx   (terminal boxes)
//
// Statements are separated by newlines or `;`. On a structural line, top-level
// commas separate independent formulas (`A ~ L, Y ~ A + L`). Role-annotation
// lines take a comma-separated id list after the colon.
//
// parse() returns { model, flags } — flags lists lines it could not interpret.
// Coordinates are not part of the DSL; parse() leaves x=y=0 and the caller runs
// layout.mjs. emit() is the inverse and is round-trip stable up to layout.

import { emptyModel, defaultLabel, ROLES } from './model.mjs';

const ROLE_KEYWORDS = {
  exposure: { role: 'exposure' },
  outcome: { role: 'outcome' },
  confounder: { role: 'confounder' },
  mediator: { role: 'mediator' },
  collider: { role: 'collider' },
  instrument: { role: 'instrument' },
  covariate: { role: 'covariate' },
  latent: { role: 'latent', style: 'unobs' },
  unmeasured: { role: 'latent', style: 'unobs' },
  adjusted: { style: 'cond' },
  decision: { style: 'decision' },
  leaf: { style: 'leaf' },
  recommend: { style: 'leafPos' },
  avoid: { style: 'leafNeg' },
};

// Flowchart styles <-> their annotation keyword (inverse of ROLE_KEYWORDS above).
const STYLE_TO_KEYWORD = { decision: 'decision', leaf: 'leaf', leafPos: 'recommend', leafNeg: 'avoid' };

const ID = '[A-Za-z][A-Za-z0-9]*';

export function parse(text) {
  const model = emptyModel();
  const flags = [];
  const nodeMap = new Map();

  const ensure = (id) => {
    if (!nodeMap.has(id)) {
      const n = { id, label: defaultLabel(id), x: 0, y: 0, style: 'rv' };
      nodeMap.set(id, n);
      model.nodes.push(n);
    }
    return nodeMap.get(id);
  };
  const addEdge = (from, to, style = 'causal', label = null) => {
    let e = model.edges.find((x) => x.from === from && x.to === to && x.style === style);
    if (!e) { e = { from, to, style, bend: 0 }; model.edges.push(e); }
    if (label != null) { e.label = label; e.labelPos = 'above'; }
    return e;
  };

  const lines = text.split(/[\n;]+/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('%')) return;

    // Role annotation?
    const roleM = new RegExp(`^(${Object.keys(ROLE_KEYWORDS).join('|')})\\s*:\\s*(.+)$`, 'i').exec(line);
    if (roleM) {
      const spec = ROLE_KEYWORDS[roleM[1].toLowerCase()];
      roleM[2].split(',').map((s) => s.trim()).filter(Boolean).forEach((id) => {
        if (!new RegExp(`^${ID}$`).test(id)) { flags.push({ line: i + 1, why: `invalid id '${id}'` }); return; }
        const n = ensure(id);
        if (spec.role) n.role = spec.role;
        if (spec.style) n.style = spec.style;
      });
      return;
    }

    // Structural line: split on top-level commas into independent statements.
    let handled = false;
    for (const seg of line.split(',')) {
      const s = seg.trim();
      if (!s) continue;
      if (!parseStatement(s, ensure, addEdge)) {
        flags.push({ line: i + 1, why: `could not parse '${s}'` });
      } else {
        handled = true;
      }
    }
    if (!handled && !line.includes(',')) { /* single unparsed statement already flagged */ }
  });

  return { model, flags };
}

function parseStatement(s, ensure, addEdge) {
  // Bidirected: a <-> b
  let m = new RegExp(`^(${ID})\\s*<->\\s*(${ID})$`).exec(s);
  if (m) {
    ensure(m[1]); ensure(m[2]);
    addEdge(m[1], m[2], 'bidirected');
    return true;
  }
  // Labelled single arrow: a -> b : label  (quotes optional; branch condition)
  m = new RegExp(`^(${ID})\\s*->\\s*(${ID})\\s*:\\s*(.+)$`).exec(s);
  if (m) {
    ensure(m[1]); ensure(m[2]);
    const label = m[3].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    addEdge(m[1], m[2], 'causal', label);
    return true;
  }
  // Arrow chain: a -> b -> c
  if (/->/.test(s) && !s.includes('~')) {
    const parts = s.split('->').map((p) => p.trim());
    if (parts.length < 2 || !parts.every((p) => new RegExp(`^${ID}$`).test(p))) return false;
    for (let k = 0; k < parts.length; k++) ensure(parts[k]);
    for (let k = 0; k < parts.length - 1; k++) addEdge(parts[k], parts[k + 1], 'causal');
    return true;
  }
  // Formula: child ~ rhs
  m = new RegExp(`^(${ID})\\s*~\\s*(.+)$`).exec(s);
  if (m) {
    const child = m[1];
    ensure(child);
    const rhs = m[2].trim();
    if (rhs === '1' || rhs === '0' || rhs === '') return true; // no parents
    const parents = rhs.split('+').map((p) => p.trim());
    for (const p of parents) {
      if (!new RegExp(`^${ID}$`).test(p)) return false;
      ensure(p);
      addEdge(p, child, 'causal');
    }
    return true;
  }
  // Bare node declaration
  if (new RegExp(`^${ID}$`).test(s)) { ensure(s); return true; }
  return false;
}

export function emit(model) {
  const lines = [];

  // Role annotations, grouped.
  const byRole = {};
  const unmeasured = [];
  const adjusted = [];
  const flowchart = { decision: [], leaf: [], leafPos: [], leafNeg: [] };
  for (const n of model.nodes) {
    if (n.style === 'unobs') unmeasured.push(n.id);
    else if (n.style === 'cond') adjusted.push(n.id);
    else if (flowchart[n.style]) flowchart[n.style].push(n.id);
    if (n.role && ROLES.includes(n.role) && n.role !== 'latent') (byRole[n.role] ||= []).push(n.id);
  }
  for (const role of ['exposure', 'outcome', 'confounder', 'mediator', 'collider', 'instrument', 'covariate']) {
    if (byRole[role]) lines.push(`${role}: ${byRole[role].join(', ')}`);
  }
  if (unmeasured.length) lines.push(`unmeasured: ${unmeasured.join(', ')}`);
  if (adjusted.length) lines.push(`adjusted: ${adjusted.join(', ')}`);
  for (const style of ['decision', 'leaf', 'leafPos', 'leafNeg']) {
    if (flowchart[style].length) lines.push(`${STYLE_TO_KEYWORD[style]}: ${flowchart[style].join(', ')}`);
  }
  if (lines.length) lines.push('');

  // Structural formulas, one line per child that has causal parents. Labelled
  // causal edges emit as their own `from -> to : "label"` line (the `~` form
  // can't carry a per-parent label), so they're pulled out of the grouping.
  const causalParents = {};
  const labelled = [];
  const bidirected = [];
  for (const e of model.edges) {
    if (e.style === 'bidirected') bidirected.push(e);
    else if (e.style === 'causal' || e.style === 'cfedge' || e.style === 'det') {
      if (e.label) labelled.push(e);
      else (causalParents[e.to] ||= []).push(e.from);
    }
  }
  const withParents = new Set(Object.keys(causalParents));
  for (const n of model.nodes) {
    if (causalParents[n.id]) lines.push(`${n.id} ~ ${causalParents[n.id].join(' + ')}`);
  }
  for (const e of labelled) { lines.push(`${e.from} -> ${e.to} : "${e.label}"`); withParents.add(e.to); }
  for (const e of bidirected) lines.push(`${e.from} <-> ${e.to}`);

  // Isolated nodes (no parents, no bidirected, no role annotation) — preserve them.
  const annotated = new Set([...unmeasured, ...adjusted, ...Object.values(byRole).flat(), ...Object.values(flowchart).flat()]);
  const inBidir = new Set(bidirected.flatMap((e) => [e.from, e.to]));
  const hasChildren = new Set(model.edges.map((e) => e.from));
  for (const n of model.nodes) {
    if (!withParents.has(n.id) && !annotated.has(n.id) && !inBidir.has(n.id) && !hasChildren.has(n.id)) {
      lines.push(`${n.id} ~ 1`);
    }
  }

  return lines.join('\n').trim();
}
