// DAG patches — the structured form of a session's suggested edit.
//
// A patch is a list of ops against a base model. It is what a `dag-patch` ask
// card carries, and it is applied only from Alec's Accept click, as one undo
// step. Ops name nodes by id and edges by endpoints (the handle grammar), so a
// patch survives any edit elsewhere in the graph and fails loudly on an edit to
// something it touches.
//
//   { op:'add-node',    node:{ id, label?, style?, role?, x?, y?, fill?, stroke?, text? } }
//   { op:'remove-node', id }                     (its edges go with it)
//   { op:'set-node',    id, set:{ label?, style?, role?, x?, y?, fill?, stroke?, text? } }
//   { op:'add-edge',    edge:{ from, to, style?, bend?, label?, labelPos? } }
//   { op:'remove-edge', from, to }
//   { op:'set-edge',    from, to, set:{ style?, bend?, label?, labelPos? } }
//
// applyPatch is all-or-nothing: any conflict returns the input model untouched.

import { cloneModel, normalizeNode, normalizeEdge, validate } from './model.mjs';

export const NODE_FIELDS = ['label', 'style', 'role', 'fill', 'stroke', 'text'];
export const EDGE_FIELDS = ['style', 'bend', 'label', 'labelPos'];
const POS = ['x', 'y'];

const edgeKey = (e) => `${e.from}->${e.to}`;
const same = (a, b) => (a ?? null) === (b ?? null);

// Ops that turn `a` into `b`.
//   nodeFields / edgeFields: which attributes to compare. A formula or dagitty
//     input carries no labels or colours, so comparing them would propose
//     overwriting every label Alec has written — the CLI narrows these by input.
//   positions: compare x/y and carry them on added nodes. Off by default: a
//     suggestion's coordinates come from its own layout, not from Alec's canvas,
//     so new nodes are placed next to their neighbours instead.
export function diffModels(a, b, { nodeFields = NODE_FIELDS, edgeFields = EDGE_FIELDS, positions = false } = {}) {
  const ops = [];
  const aNodes = new Map(a.nodes.map((n) => [n.id, n]));
  const bNodes = new Map(b.nodes.map((n) => [n.id, n]));
  const removed = new Set();

  for (const n of a.nodes) {
    if (!bNodes.has(n.id)) { ops.push({ op: 'remove-node', id: n.id }); removed.add(n.id); }
  }
  for (const n of b.nodes) {
    const old = aNodes.get(n.id);
    if (!old) {
      const node = { ...n };
      if (!positions) { delete node.x; delete node.y; }
      ops.push({ op: 'add-node', node });
      continue;
    }
    const set = {};
    for (const k of [...nodeFields, ...(positions ? POS : [])]) if (!same(old[k], n[k])) set[k] = n[k] ?? null;
    if (Object.keys(set).length) ops.push({ op: 'set-node', id: n.id, set });
  }

  const aEdges = new Map(a.edges.map((e) => [edgeKey(e), e]));
  const bEdges = new Map(b.edges.map((e) => [edgeKey(e), e]));
  for (const e of a.edges) {
    if (bEdges.has(edgeKey(e)) || removed.has(e.from) || removed.has(e.to)) continue;
    ops.push({ op: 'remove-edge', from: e.from, to: e.to });
  }
  for (const e of b.edges) {
    const old = aEdges.get(edgeKey(e));
    if (!old) { ops.push({ op: 'add-edge', edge: { ...e } }); continue; }
    const set = {};
    for (const k of edgeFields) if (!same(old[k], e[k])) set[k] = e[k] ?? null;
    if (Object.keys(set).length) ops.push({ op: 'set-edge', from: e.from, to: e.to, set });
  }
  return ops;
}

// -> { model, conflicts: [string] }. On conflict, `model` is the input, untouched.
export function applyPatch(model, ops) {
  const conflicts = [];
  if (!Array.isArray(ops) || !ops.length) return { model, conflicts: ['the patch has no ops'] };
  const m = cloneModel(model);
  const unplaced = new Set();

  for (const o of ops) {
    const nodeAt = (id) => m.nodes.findIndex((n) => n.id === id);
    const edgeAt = (from, to) => m.edges.findIndex((e) => e.from === from && e.to === to);
    switch (o?.op) {
      case 'add-node': {
        if (!o.node?.id) { conflicts.push('add-node without an id'); break; }
        if (nodeAt(o.node.id) >= 0) { conflicts.push(`node '${o.node.id}' already exists`); break; }
        if (!Number.isFinite(o.node.x) || !Number.isFinite(o.node.y)) unplaced.add(String(o.node.id));
        m.nodes.push(normalizeNode(o.node));
        break;
      }
      case 'remove-node': {
        const i = nodeAt(o.id);
        if (i < 0) { conflicts.push(`node '${o.id}' is not in the DAG`); break; }
        m.nodes.splice(i, 1);
        m.edges = m.edges.filter((e) => e.from !== o.id && e.to !== o.id);
        if (m.swig?.interventions) m.swig.interventions = m.swig.interventions.filter((iv) => iv.node !== o.id);
        break;
      }
      case 'set-node': {
        const i = nodeAt(o.id);
        if (i < 0) { conflicts.push(`node '${o.id}' is not in the DAG`); break; }
        const next = { ...m.nodes[i] };
        for (const [k, v] of Object.entries(o.set || {})) {
          if (![...NODE_FIELDS, ...POS].includes(k)) { conflicts.push(`node '${o.id}': cannot set '${k}'`); continue; }
          if (v == null) delete next[k]; else next[k] = v;
        }
        m.nodes[i] = normalizeNode(next);
        break;
      }
      case 'add-edge': {
        const e = o.edge || {};
        if (!e.from || !e.to) { conflicts.push('add-edge needs from and to'); break; }
        if (edgeAt(e.from, e.to) >= 0) { conflicts.push(`edge ${e.from} → ${e.to} already exists`); break; }
        m.edges.push(normalizeEdge(e));
        break;
      }
      case 'remove-edge': {
        const i = edgeAt(o.from, o.to);
        if (i < 0) { conflicts.push(`edge ${o.from} → ${o.to} is not in the DAG`); break; }
        m.edges.splice(i, 1);
        break;
      }
      case 'set-edge': {
        const i = edgeAt(o.from, o.to);
        if (i < 0) { conflicts.push(`edge ${o.from} → ${o.to} is not in the DAG`); break; }
        const next = { ...m.edges[i] };
        for (const [k, v] of Object.entries(o.set || {})) {
          if (!EDGE_FIELDS.includes(k)) { conflicts.push(`edge ${o.from} → ${o.to}: cannot set '${k}'`); continue; }
          if (v == null) delete next[k]; else next[k] = v;
        }
        m.edges[i] = normalizeEdge(next);
        break;
      }
      default:
        conflicts.push(`unknown op '${o?.op}'`);
    }
  }

  if (!conflicts.length) {
    const v = validate(m);
    conflicts.push(...v.errors);
    // A cycle is only a warning in validate(), but a patch that CREATES one in a
    // DAG is refused: accepting it would turn a suggestion into a broken graph.
    const before = validate(model).warnings.some((w) => w.includes('directed cycle'));
    const cyc = v.warnings.find((w) => w.includes('directed cycle'));
    if (cyc && !before && (m.meta?.kind || 'dag') === 'dag') conflicts.push(cyc.replace('graph contains', 'the patch creates'));
  }
  if (conflicts.length) return { model, conflicts };

  placeNodes(m, unplaced);
  return { model: m, conflicts };
}

// Put each unplaced node on the free integer grid cell nearest the mean of its
// placed neighbours (or right of the graph when it has none). Deterministic, so
// a card's preview and the accepted result agree.
export function placeNodes(model, ids) {
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const placed = new Set(model.nodes.filter((n) => !ids.has(n.id)).map((n) => n.id));
  const taken = new Set(model.nodes.filter((n) => placed.has(n.id)).map((n) => `${n.x},${n.y}`));
  const maxX = Math.max(0, ...model.nodes.filter((n) => placed.has(n.id)).map((n) => n.x));

  for (const id of ids) {
    const node = byId.get(id);
    if (!node) continue;
    const nbrs = model.edges
      .flatMap((e) => (e.from === id ? [e.to] : e.to === id ? [e.from] : []))
      .filter((n) => placed.has(n))
      .map((n) => byId.get(n));
    const tx = nbrs.length ? Math.round(nbrs.reduce((s, n) => s + n.x, 0) / nbrs.length) : maxX + 1;
    const ty = nbrs.length ? Math.round(nbrs.reduce((s, n) => s + n.y, 0) / nbrs.length) : 0;
    const [x, y] = nearestFree(tx, ty, taken);
    node.x = x; node.y = y;
    taken.add(`${x},${y}`);
    placed.add(id);
  }
  return model;
}

function nearestFree(tx, ty, taken) {
  for (let r = 0; r < 64; r++) {
    const ring = [];
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) === r) ring.push([dx, dy]);
      }
    }
    // Nearest first; then prefer staying on the target's row, then to the right.
    ring.sort((p, q) => (Math.abs(p[0]) + Math.abs(p[1])) - (Math.abs(q[0]) + Math.abs(q[1]))
      || Math.abs(p[1]) - Math.abs(q[1]) || q[0] - p[0] || p[1] - q[1]);
    for (const [dx, dy] of ring) if (!taken.has(`${tx + dx},${ty + dy}`)) return [tx + dx, ty + dy];
  }
  return [tx, ty];
}

// One human-readable line per op, for the card and the CLI.
export function describeOps(ops, base = null) {
  const node = (id) => base?.nodes.find((n) => n.id === id);
  const edge = (f, t) => base?.edges.find((e) => e.from === f && e.to === t);
  const sets = (old, set) => Object.entries(set || {})
    .map(([k, v]) => `${k} ${JSON.stringify(old?.[k] ?? null)} → ${JSON.stringify(v)}`).join(', ');
  return ops.map((o) => {
    switch (o.op) {
      case 'add-node': return { sign: '+', text: `node ${o.node.id}${o.node.label ? ` (${o.node.label})` : ''}` };
      case 'remove-node': return { sign: '−', text: `node ${o.id} and its edges` };
      case 'set-node': return { sign: '~', text: `node ${o.id}: ${sets(node(o.id), o.set)}` };
      case 'add-edge': return { sign: '+', text: `edge ${o.edge.from} → ${o.edge.to}${o.edge.style && o.edge.style !== 'causal' ? ` (${o.edge.style})` : ''}` };
      case 'remove-edge': return { sign: '−', text: `edge ${o.from} → ${o.to}` };
      case 'set-edge': return { sign: '~', text: `edge ${o.from} → ${o.to}: ${sets(edge(o.from, o.to), o.set)}` };
      default: return { sign: '?', text: `unknown op ${JSON.stringify(o?.op)}` };
    }
  });
}

// Handles of the EXISTING things a patch touches — what "Show me" highlights
// before Alec decides. Added nodes aren't on the canvas yet; their neighbours are.
export function touchedHandles(ops, base) {
  const ids = new Set(base.nodes.map((n) => n.id));
  const out = new Set();
  const node = (id) => { if (ids.has(id)) out.add(`@node:${id}`); };
  for (const o of ops) {
    if (o.op === 'remove-node' || o.op === 'set-node') node(o.id);
    else if (o.op === 'add-edge') { node(o.edge.from); node(o.edge.to); }
    else if (o.op === 'remove-edge' || o.op === 'set-edge') out.add(`@edge:${o.from}->${o.to}`);
  }
  return [...out];
}
