// Carry the arrangement across a text-panel edit.
//
// A formula (and a dagitty block with no pos) says STRUCTURE: which nodes exist
// and what points at what. Parsing one yields a model with no coordinates, no
// labels, no colours and no bends, so replacing the model with it throws away
// everything arranged on the canvas. carryOver(prev, next, dialect) keeps, for
// every node and edge that is in both, whatever the dialect cannot say, and
// places only the nodes that are new, next to their neighbours. The text still
// wins on what it does say.
//
// The automatic layout runs only when nothing carries over (a blank canvas, or
// a wholly different graph).

import { ROLES } from './model.mjs';
import { layout } from './layout.mjs';
import { placeNodes } from './patch.mjs';

// What each dialect can express. `unseenEdges`: edge styles its emit() leaves
// out altogether, so their absence from the text is not a deletion.
export const FORMULA = {
  positions: false,
  nodeStyles: ['rv', 'unobs', 'cond', 'decision', 'leaf', 'leafPos', 'leafNeg'],
  roles: ROLES,
  edgeLabels: true,
  unseenEdges: ['reads', 'biasing', 'blocked'],
};
export const DAGITTY = {
  positions: true,
  nodeStyles: ['rv', 'cond', 'unobs'],
  roles: ['exposure', 'outcome', 'latent'],
  edgeLabels: false,
  unseenEdges: [],
};

const edgeKey = (e) => `${e.from}->${e.to}`;

// Mutates and returns `next`.
//   placed: ids whose position the text states (dagitty pos=); those are obeyed.
//   memory: a Map the caller keeps across edits. A node that drops out while a
//     line is half-typed is remembered there and comes back where it was.
export function carryOver(prev, next, { positions = false, nodeStyles = [], roles = [], edgeLabels = false, unseenEdges = [], placed = null, memory = null } = {}) {
  const oldNodes = new Map(prev.nodes.map((n) => [n.id, n]));
  const oldEdges = new Map(prev.edges.map((e) => [edgeKey(e), e]));
  const ids = new Set(next.nodes.map((n) => n.id));
  const stated = (id) => positions && !!placed?.has(id);

  let kept = 0;
  const unplaced = new Set();
  for (const n of next.nodes) {
    const old = oldNodes.get(n.id) ?? memory?.get(n.id);
    if (!old) { if (!stated(n.id)) unplaced.add(n.id); continue; }
    kept++;
    n.label = old.label;
    for (const k of ['fill', 'stroke', 'text']) if (old[k] != null) n[k] = old[k];
    if (!stated(n.id)) { n.x = old.x; n.y = old.y; }
    if (n.style === 'rv' && !nodeStyles.includes(old.style)) n.style = old.style;
    if (!n.role && old.role && !roles.includes(old.role)) n.role = old.role;
  }

  const have = new Set(next.edges.map(edgeKey));
  for (const e of next.edges) {
    const old = oldEdges.get(edgeKey(e)) ?? memory?.get(edgeKey(e));
    if (!old) continue;
    e.bend = old.bend;
    if (e.style === 'causal' && old.style !== 'bidirected') e.style = old.style;
    if (!edgeLabels && old.label != null) e.label = old.label;
    if (e.label != null && old.labelPos) e.labelPos = old.labelPos;
  }
  // Edges the text cannot show stay, while both their ends do.
  for (const old of [...prev.edges, ...(memory ? memory.values() : [])]) {
    if (!old.from || !unseenEdges.includes(old.style) || have.has(edgeKey(old))) continue;
    if (ids.has(old.from) && ids.has(old.to)) { next.edges.push({ ...old }); have.add(edgeKey(old)); }
  }

  if (memory) {
    for (const n of prev.nodes) if (!ids.has(n.id)) memory.set(n.id, { ...n });
    for (const e of prev.edges) if (!have.has(edgeKey(e))) memory.set(edgeKey(e), { ...e });
  }

  next.meta = { ...next.meta, ...prev.meta };
  const interventions = prev.swig?.interventions.filter((iv) => ids.has(iv.node)) || [];
  if (interventions.length) next.swig = { interventions: interventions.map((iv) => ({ ...iv })) };

  if (!kept && !(positions && placed?.size)) layout(next);
  else placeNodes(next, unplaced);
  return next;
}
