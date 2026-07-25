// DAG -> SWIG transform (Richardson-Robins split-node style). Intervening on a
// treatment node draws a vertical orange split-bar through it and attaches a
// small orange "fixed" node carrying the set value (e.g. $a$) just to its
// right; the treatment's causal out-edges are re-sourced from that fixed value
// as orange `cfedge`s. Every node downstream of one or more interventions is
// relabelled with potential-outcome notation, e.g. $H_1$ -> $H_1(a, v_0)$,
// accumulating one argument per intervention that causally reaches it (in the
// order the interventions were given, so multi-part interventions like
// intervene(m, ['A', 'V0']) produce $H_1(a, v_0)$ rather than two passes of
// generic superscripts). Reproduces the grammar of swig-template.tex.

import { cloneModel, descendantsOf, childrenOf, FLOW_STYLES } from './model.mjs';

// Grid-unit gap left for a fixed-value node when splitting a treatment (tight,
// centered split; see \splitbar in tikz/dag-styles.tex). A flat constant
// collides in practice: if the intervened node is itself a descendant of an
// earlier intervention (e.g. V0 downstream of A), its label already carries a
// potential-outcome argument (e.g. $V_0(\cfarg{a})$) and is visibly wider than
// a bare label, so a fixed gap places the fixed-value node too close and the
// split-bar runs through its text. Scale the gap by how much is already inside
// the label's outermost parens (confirmed by actually compiling the TikZ and
// looking for overlap, not just by eyeballing the coordinate math).
const BASE_DELTA = 0.4;
const DELTA_PER_ARG_CHAR = 0.08;

function splitDelta(label) {
  const inner = String(label).replace(/^\$/, '').replace(/\$$/, '');
  const m = inner.match(/\(([^()]*)\)$/);
  return BASE_DELTA + (m ? DELTA_PER_ARG_CHAR * m[1].length : 0);
}

// intervene(model, nodeId | [nodeId, ...], { values: { [nodeId]: 'a' } })
export function intervene(model, nodeIds, opts = {}) {
  const ids = Array.isArray(nodeIds) ? nodeIds : [nodeIds];
  const m = cloneModel(model);

  for (const id of ids) {
    if (!m.nodes.some((n) => n.id === id)) throw new Error(`intervene: no node '${id}'`);
  }

  const value = {};
  for (const id of ids) value[id] = opts.values?.[id] || defaultValueSymbol(id);

  // Descendants computed on the pre-transform graph, before any node gets split.
  const desc = {};
  for (const id of ids) desc[id] = descendantsOf(m, id);

  // Relabel every node affected by one or more interventions with the ordered
  // list of potential-outcome arguments that reach it (an intervened node
  // itself may be a descendant of an earlier one, e.g. V0 depends on A).
  for (const n of m.nodes) {
    const args = ids.filter((id) => id !== n.id && desc[id].has(n.id)).map((id) => value[id]);
    if (args.length) n.label = appendArgs(n.label, args);
  }

  m.meta.kind = 'swig';
  m.swig ||= { interventions: [] };

  for (const id of ids) {
    const target = m.nodes.find((n) => n.id === id);
    const fixedId = uniqueId(m, `${id}_v`);
    const delta = splitDelta(target.label);

    // Make room for the fixed-value node: shift every other node whose x is
    // past the intervened node by delta, so the tight split doesn't squash
    // whatever used to sit immediately downstream (and nodes column-aligned
    // with `id` stay aligned with its new column after the shift).
    for (const n of m.nodes) {
      if (n.x > target.x) n.x += delta;
    }
    m.nodes.push({ id: fixedId, label: `$${value[id]}$`, x: target.x + delta, y: target.y, style: 'fixed' });

    // Re-source the treatment's causal out-edges from its fixed value as cfedges.
    const outKids = childrenOf(m, id);
    m.edges = m.edges.filter((e) => !(e.from === id && (e.style === 'causal' || e.style === 'det')));
    for (const kid of outKids) m.edges.push({ from: fixedId, to: kid, style: 'cfedge', bend: 0 });

    if (!m.swig.interventions.some((iv) => iv.node === id)) {
      m.swig.interventions.push({ node: id, regimeLabel: fixedId, value: value[id] });
    }
  }

  return m;
}

// A -> a, V0 -> v_0, X1 -> x_1 (bare letters lowercase; trailing digits become a subscript).
function defaultValueSymbol(id) {
  const m = /^([A-Za-z]+)(\d+)?$/.exec(String(id));
  if (!m) return String(id).toLowerCase();
  const [, letters, digits] = m;
  return digits ? `${letters.toLowerCase()}_${digits}` : letters.toLowerCase();
}

function appendArgs(label, args) {
  const inner = String(label).replace(/^\$/, '').replace(/\$$/, '');
  const wrapped = args.map((a) => `\\cfarg{${a}}`);
  // idempotent: merge into an existing arg list rather than appending a second one.
  const m = inner.match(/^(.*)\(([^()]*)\)$/);
  if (m) {
    const [, base, existing] = m;
    const have = existing.split(',').map((s) => s.trim()).filter(Boolean);
    for (const a of wrapped) if (!have.includes(a)) have.push(a);
    return `$${base}(${have.join(', ')})$`;
  }
  return `$${inner}(${wrapped.join(', ')})$`;
}

// Render/emit-time presentation of a potential-outcome label. The stored label is
// always the canonical paren form ($Y(\cfarg{a})$); 'superscript' style reformats
// the trailing argument list into $Y^{\cfarg{a}}$ instead. Labels with no argument
// list (most nodes, and the plain `$a$` fixed-value nodes) pass through unchanged.
// Node-aware wrapper: flowchart nodes carry prose, so their labels are never
// reinterpreted as potential outcomes. Use this wherever a NODE is rendered or
// emitted; call formatSwigLabel directly only when there is no node in hand.
export function formatNodeLabel(node, style) {
  return FLOW_STYLES.includes(node.style) ? node.label : formatSwigLabel(node.label, style);
}

export function formatSwigLabel(label, style) {
  if (style !== 'superscript') return label;
  const inner = String(label).replace(/^\$/, '').replace(/\$$/, '');
  const m = inner.match(/^(.*)\(([^()]*)\)$/);
  if (!m) return label;
  const [, base, args] = m;
  // A base that already ends in its own superscript (e.g. $H^{*}$, given as-is
  // before any intervention) would otherwise stack a second ^{...} on top of it --
  // invalid LaTeX ("double superscript"). Merge into the existing group instead.
  const sup = base.match(/^(.*)\^\{([^}]*)\}$/) || base.match(/^(.*)\^(\S)$/);
  if (sup) return `$${sup[1]}^{${sup[2]}, ${args}}$`;
  return `$${base}^{${args}}$`;
}

function uniqueId(model, base) {
  const ids = new Set(model.nodes.map((n) => n.id));
  if (!ids.has(base)) return base;
  let i = 1; while (ids.has(base + i)) i++; return base + i;
}
