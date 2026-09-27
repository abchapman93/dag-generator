// Point-at handles — the dag-generator binding of the collab grammar.
//
//   @node:<id>          a node, by its model id
//   @edge:<from>-><to>  an edge, by its endpoints
//
// The model's own ids ARE the handles, so there is no anchor machinery: a handle
// either resolves against the current model or it doesn't. Used in both
// directions — the canvas formats them when Alec points at something, and
// parses them when a session points back (an ask whose payload carries
// `anchor`). Ids may contain '-'; they may not contain '->'.

export function formatHandle(item) {
  if (item.type === 'edge') return `@edge:${item.from}->${item.to}`;
  return `@node:${item.id}`;
}

// -> { type:'node', id } | { type:'edge', from, to } | null (not a dag handle)
export function parseHandle(handle) {
  const s = String(handle ?? '').trim();
  if (s.startsWith('@node:')) {
    const id = s.slice(6);
    return id ? { type: 'node', id } : null;
  }
  if (s.startsWith('@edge:')) {
    const body = s.slice(6);
    const i = body.indexOf('->');
    if (i <= 0 || i + 2 >= body.length) return null;
    return { type: 'edge', from: body.slice(0, i), to: body.slice(i + 2) };
  }
  return null;
}

// Resolve handles against a model. `found` holds node ids and edge indices;
// `missing` holds the handles that no longer match anything (reported, never
// silently dropped).
export function resolveHandles(model, handles) {
  const list = Array.isArray(handles) ? handles : [handles];
  const found = [];
  const missing = [];
  for (const h of list) {
    const p = parseHandle(h);
    if (p?.type === 'node' && model.nodes.some((n) => n.id === p.id)) found.push({ type: 'node', id: p.id });
    else if (p?.type === 'edge') {
      const index = model.edges.findIndex((e) => e.from === p.from && e.to === p.to);
      if (index >= 0) found.push({ type: 'edge', index });
      else missing.push(String(h));
    } else missing.push(String(h));
  }
  return { found, missing };
}
