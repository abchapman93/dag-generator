// DAG -> SWIG transform. Intervening on a treatment node splits it into the
// observed decision (kept) and a regime node (orange diamond); the regime reads
// the treatment's determinants (dashed `reads` edges), pushes to the
// counterfactual descendants (orange `cfedge`), and every descendant of the
// split is relabelled counterfactual with a superscript. Reproduces the grammar
// of swig-template.tex (basic form — one intervention; see fast-follows for
// multi-regime and \cfs orange superscripts).

import { cloneModel, descendantsOf, childrenOf, parentsOf, defaultLabel } from './model.mjs';

// intervene(model, nodeId, { regimeId, regimeLabel, superscript })
export function intervene(model, nodeId, opts = {}) {
  const m = cloneModel(model);
  const target = m.nodes.find((n) => n.id === nodeId);
  if (!target) throw new Error(`intervene: no node '${nodeId}'`);

  const sup = opts.superscript || 's';
  const regimeId = opts.regimeId || uniqueId(m, 'G');
  const regimeLabel = opts.regimeLabel || `$${regimeId}^{(${sup})}$`;

  // Counterfactual descendants of the split (computed on the pre-transform graph).
  const cf = descendantsOf(m, nodeId);

  // Regime node: just right of the treatment, on its row.
  m.nodes.push({ id: regimeId, label: regimeLabel, x: target.x + 1, y: target.y, style: 'regime' });

  // Reads edges: regime reads the treatment's parents (its determinants).
  for (const p of parentsOf(m, nodeId)) {
    if (!m.edges.some((e) => e.from === p && e.to === regimeId)) {
      m.edges.push({ from: p, to: regimeId, style: 'reads', bend: 0 });
    }
  }

  // Re-source the treatment's causal out-edges from the regime as cfedges.
  const outKids = childrenOf(m, nodeId);
  m.edges = m.edges.filter((e) => !(e.from === nodeId && (e.style === 'causal' || e.style === 'det')));
  for (const kid of outKids) {
    m.edges.push({ from: regimeId, to: kid, style: 'cfedge', bend: 0 });
  }

  // Relabel counterfactual descendants with the superscript.
  for (const n of m.nodes) {
    if (cf.has(n.id)) n.label = cfSuperscript(n.label, sup);
  }

  m.meta.kind = 'swig';
  m.swig ||= { interventions: [] };
  if (!m.swig.interventions.some((iv) => iv.node === nodeId)) {
    m.swig.interventions.push({ node: nodeId, regimeLabel: regimeId });
  }
  return m;
}

function cfSuperscript(label, sup) {
  const inner = String(label).replace(/^\$/, '').replace(/\$$/, '');
  if (new RegExp(`\\^\\{?${sup}`).test(inner)) return label; // already counterfactual
  return `$${inner}^{${sup}}$`;
}

function uniqueId(model, base) {
  const ids = new Set(model.nodes.map((n) => n.id));
  if (!ids.has(base)) return base;
  let i = 1; while (ids.has(base + i)) i++; return base + i;
}
