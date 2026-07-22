// Canonical DAG/SWIG model — the hub every surface (formula, dagitty, tikz, svg,
// html, layout) converts to and from. Pure data + validation, no I/O.
//
// Model shape:
//   {
//     meta:  { kind, style, title, nodeSep, swigStyle },
//     nodes: [ { id, label, x, y, style, role } ],
//     edges: [ { from, to, style, bend } ],
//     swig?: { interventions: [ { node, regimeLabel } ] }
//   }
//
// Design note: the primitive `node.style` (rv|cond|unobs|regime|fixed) is the
// AUTHORITATIVE field for rendering and for the canonical-TikZ round-trip — it is
// always preserved. `node.role` is optional semantic metadata (exposure, outcome,
// …) that drives informal-style colouring and the formula DSL; it may be absent
// after a TikZ import because primitive→semantic is not lossless.

export const NODE_STYLES = ['rv', 'cond', 'unobs', 'regime', 'fixed'];
export const EDGE_STYLES = ['causal', 'reads', 'cfedge', 'det', 'biasing', 'blocked', 'bidirected'];
export const ROLES = ['exposure', 'outcome', 'confounder', 'mediator', 'collider', 'instrument', 'covariate', 'latent'];
export const KINDS = ['dag', 'swig'];
export const RENDER_STYLES = ['informal', 'manuscript'];
// How a SWIG's potential-outcome argument list is displayed: 'paren' -- $Y(\cfarg{a})$
// (the default, matching swig-template.tex) -- or 'superscript' -- $Y^{\cfarg{a}}$.
// Document-wide, applied at render/emit time (see formatSwigLabel in swig.mjs); the
// stored node.label always stays in canonical paren form.
export const SWIG_STYLES = ['paren', 'superscript'];

// A role, when set via the formula/dagitty DSL, implies a primitive tikz style.
export const ROLE_TO_STYLE = {
  exposure: 'rv',
  outcome: 'rv',
  confounder: 'rv',
  mediator: 'rv',
  collider: 'rv',
  instrument: 'rv',
  covariate: 'rv',
  latent: 'unobs',
};

export function emptyModel(overrides = {}) {
  return {
    meta: { kind: 'dag', style: 'informal', title: '', nodeSep: 1, swigStyle: 'paren', ...(overrides.meta || {}) },
    nodes: overrides.nodes ? overrides.nodes.map(normalizeNode) : [],
    edges: overrides.edges ? overrides.edges.map(normalizeEdge) : [],
    ...(overrides.swig ? { swig: overrides.swig } : {}),
  };
}

export function normalizeNode(n) {
  const node = {
    id: String(n.id),
    label: n.label != null ? String(n.label) : defaultLabel(n.id),
    x: Number.isFinite(n.x) ? n.x : 0,
    y: Number.isFinite(n.y) ? n.y : 0,
    style: NODE_STYLES.includes(n.style) ? n.style : 'rv',
  };
  if (n.role && ROLES.includes(n.role)) node.role = n.role;
  return node;
}

export function normalizeEdge(e) {
  return {
    from: String(e.from),
    to: String(e.to),
    style: EDGE_STYLES.includes(e.style) ? e.style : 'causal',
    bend: Number.isFinite(e.bend) ? e.bend : 0,
  };
}

// A bare id becomes an italic-math label: A -> $A$, U1 -> $U_1$.
export function defaultLabel(id) {
  const m = /^([A-Za-z]+)(\d+)$/.exec(String(id));
  if (m) return `$${m[1]}_{${m[2]}}$`;
  return `$${id}$`;
}

export function getNode(model, id) {
  return model.nodes.find((n) => n.id === id);
}

export function nodeIds(model) {
  return new Set(model.nodes.map((n) => n.id));
}

// Direct causal children of a node (following `causal`/`cfedge`/`det` arrows).
export function childrenOf(model, id) {
  const dir = new Set(['causal', 'cfedge', 'det']);
  return model.edges.filter((e) => e.from === id && dir.has(e.style)).map((e) => e.to);
}

export function parentsOf(model, id) {
  const dir = new Set(['causal', 'cfedge', 'det']);
  return model.edges.filter((e) => e.to === id && dir.has(e.style)).map((e) => e.from);
}

// All descendants of `id` along directed edges (used by the SWIG transform).
export function descendantsOf(model, id) {
  const seen = new Set();
  const stack = [...childrenOf(model, id)];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const c of childrenOf(model, cur)) stack.push(c);
  }
  return seen;
}

// Validate a model. Returns { ok, errors:[], warnings:[] }. Does not throw.
export function validate(model) {
  const errors = [];
  const warnings = [];
  if (!model || typeof model !== 'object') return { ok: false, errors: ['model is not an object'], warnings };

  const meta = model.meta || {};
  if (meta.kind && !KINDS.includes(meta.kind)) errors.push(`unknown kind '${meta.kind}'`);
  if (meta.style && !RENDER_STYLES.includes(meta.style)) errors.push(`unknown render style '${meta.style}'`);
  if (meta.swigStyle && !SWIG_STYLES.includes(meta.swigStyle)) errors.push(`unknown swig style '${meta.swigStyle}'`);

  if (!Array.isArray(model.nodes)) errors.push('nodes is not an array');
  if (!Array.isArray(model.edges)) errors.push('edges is not an array');
  if (errors.length) return { ok: false, errors, warnings };

  const seen = new Set();
  for (const n of model.nodes) {
    if (!n.id) errors.push('node with empty id');
    if (seen.has(n.id)) errors.push(`duplicate node id '${n.id}'`);
    seen.add(n.id);
    if (n.style && !NODE_STYLES.includes(n.style)) errors.push(`node '${n.id}': unknown style '${n.style}'`);
    if (n.role && !ROLES.includes(n.role)) errors.push(`node '${n.id}': unknown role '${n.role}'`);
  }

  for (const e of model.edges) {
    if (!seen.has(e.from)) errors.push(`edge references missing node '${e.from}'`);
    if (!seen.has(e.to)) errors.push(`edge references missing node '${e.to}'`);
    if (e.style && !EDGE_STYLES.includes(e.style)) errors.push(`edge ${e.from}->${e.to}: unknown style '${e.style}'`);
  }

  // Acyclicity among directed edges (DAG contract). SWIG counterfactual edges included.
  const cyc = findCycle(model);
  if (cyc) warnings.push(`graph contains a directed cycle: ${cyc.join(' -> ')}`);

  return { ok: errors.length === 0, errors, warnings };
}

function findCycle(model) {
  const dir = new Set(['causal', 'cfedge', 'det']);
  const adj = new Map();
  for (const n of model.nodes) adj.set(n.id, []);
  for (const e of model.edges) if (dir.has(e.style) && adj.has(e.from)) adj.get(e.from).push(e.to);

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map([...adj.keys()].map((k) => [k, WHITE]));
  const path = [];

  function dfs(u) {
    color.set(u, GRAY);
    path.push(u);
    for (const v of adj.get(u) || []) {
      if (color.get(v) === GRAY) return [...path.slice(path.indexOf(v)), v];
      if (color.get(v) === WHITE) {
        const c = dfs(v);
        if (c) return c;
      }
    }
    path.pop();
    color.set(u, BLACK);
    return null;
  }

  for (const k of adj.keys()) {
    if (color.get(k) === WHITE) {
      const c = dfs(k);
      if (c) return c;
    }
  }
  return null;
}

// Stable clone (used by transforms that must not mutate their input).
export function cloneModel(model) {
  return {
    meta: { ...model.meta },
    nodes: model.nodes.map((n) => ({ ...n })),
    edges: model.edges.map((e) => ({ ...e })),
    ...(model.swig ? { swig: { interventions: model.swig.interventions.map((i) => ({ ...i })) } } : {}),
  };
}
