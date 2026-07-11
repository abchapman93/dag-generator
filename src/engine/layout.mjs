// Automatic grid layout for a model that arrives without coordinates (from a
// formula, or dagitty without pos). Layered left→right by longest-path depth
// (causal time flows rightward), barycenter ordering within each layer to reduce
// crossings, snapped to integer grid coordinates. y points up.
//
// layout(model, opts?) mutates and returns model. Directed edges = causal /
// cfedge / det. Bidirected edges influence ordering but not layering.

const DIRECTED = new Set(['causal', 'cfedge', 'det']);

export function layout(model, opts = {}) {
  const nodes = model.nodes;
  if (!nodes.length) return model;

  const ids = nodes.map((n) => n.id);
  const idx = new Map(ids.map((id, i) => [id, i]));
  const parents = new Map(ids.map((id) => [id, []]));
  const children = new Map(ids.map((id) => [id, []]));
  const undirected = new Map(ids.map((id) => [id, []]));

  for (const e of model.edges) {
    if (DIRECTED.has(e.style)) {
      if (children.has(e.from)) children.get(e.from).push(e.to);
      if (parents.has(e.to)) parents.get(e.to).push(e.from);
    } else {
      if (undirected.has(e.from)) undirected.get(e.from).push(e.to);
      if (undirected.has(e.to)) undirected.get(e.to).push(e.from);
    }
  }

  // ---- layering: longest path from any source (Kahn topological order) ----
  const indeg = new Map(ids.map((id) => [id, parents.get(id).length]));
  const layer = new Map(ids.map((id) => [id, 0]));
  const queue = ids.filter((id) => indeg.get(id) === 0);
  const order = [];
  const work = [...queue];
  while (work.length) {
    const u = work.shift();
    order.push(u);
    for (const v of children.get(u)) {
      layer.set(v, Math.max(layer.get(v), layer.get(u) + 1));
      indeg.set(v, indeg.get(v) - 1);
      if (indeg.get(v) === 0) work.push(v);
    }
  }
  // Any nodes left in a cycle: place after their earliest processed parent.
  for (const id of ids) {
    if (!order.includes(id)) {
      const p = parents.get(id).map((x) => layer.get(x));
      layer.set(id, p.length ? Math.max(...p) + 1 : 0);
    }
  }

  // ---- group into layers, order within layer by barycenter sweeps ----
  const maxLayer = Math.max(...ids.map((id) => layer.get(id)));
  let layers = [];
  for (let l = 0; l <= maxLayer; l++) {
    layers[l] = ids.filter((id) => layer.get(id) === l).sort((a, b) => idx.get(a) - idx.get(b));
  }

  const posInLayer = new Map();
  const setPositions = () => layers.forEach((arr) => arr.forEach((id, i) => posInLayer.set(id, i)));
  setPositions();

  const neighborBary = (id) => {
    const ns = [...parents.get(id), ...children.get(id), ...undirected.get(id)]
      .filter((x) => posInLayer.has(x))
      .map((x) => posInLayer.get(x));
    if (!ns.length) return posInLayer.get(id);
    return ns.reduce((a, b) => a + b, 0) / ns.length;
  };

  for (let sweep = 0; sweep < 4; sweep++) {
    for (let l = 0; l <= maxLayer; l++) {
      const arr = layers[l];
      const keyed = arr.map((id) => ({ id, k: neighborBary(id) }));
      keyed.sort((a, b) => a.k - b.k || idx.get(a.id) - idx.get(b.id));
      layers[l] = keyed.map((o) => o.id);
      setPositions();
    }
  }

  // ---- assign integer grid coordinates (y centred per layer, y up) ----
  const xGap = opts.xGap || 2;
  for (let l = 0; l <= maxLayer; l++) {
    const arr = layers[l];
    const n = arr.length;
    arr.forEach((id, i) => {
      const node = nodes[idx.get(id)];
      node.x = l * xGap;
      node.y = Math.round((n - 1) / 2) - i; // top-first, centred
    });
  }

  return model;
}
