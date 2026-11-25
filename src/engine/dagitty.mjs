// dagitty text  <->  canonical model.
//
// Accepts the common dagitty.net / R-`dagitty` syntax:
//   dag {
//     A [exposure,pos="0.0,1.0"]
//     Y [outcome]
//     L [adjusted]
//     U [latent]
//     L -> A
//     A -> M -> Y
//     U1 <-> U2
//   }
// A leading `dag {`…`}` (or `graph`/`pdag`/`mag`) wrapper is optional. Statements
// are separated by newlines or `;`. Node attributes recognised: exposure,
// outcome, adjusted, latent/unobserved, and pos="x,y".
//
// Note on coordinates: dagitty's y-axis points DOWN. We store pos verbatim so
// parse/emit round-trip exactly; svg/layout treat model y as pointing up, so an
// imported dagitty graph may render vertically mirrored until re-laid-out. This
// is a known, documented limitation (fast-follow: flip on import).

import { emptyModel, defaultLabel, ROLES } from './model.mjs';

const ID = '[A-Za-z_][A-Za-z0-9_.]*';

export function parse(text) {
  const model = emptyModel({ meta: { style: 'informal' } });
  const flags = [];
  const nodeMap = new Map();
  const placed = new Set();   // ids whose pos the text states

  const ensure = (id) => {
    if (!nodeMap.has(id)) {
      const n = { id, label: defaultLabel(id), x: 0, y: 0, style: 'rv' };
      nodeMap.set(id, n);
      model.nodes.push(n);
    }
    return nodeMap.get(id);
  };
  const addEdge = (from, to, style) => {
    if (!model.edges.some((e) => e.from === from && e.to === to && e.style === style)) {
      model.edges.push({ from, to, style, bend: 0 });
    }
  };

  // Strip an optional `dag NAME { ... }` wrapper.
  let body = text.trim();
  const wrap = /^(?:dag|graph|pdag|mag|digraph)\b[^{]*\{([\s\S]*)\}\s*$/i.exec(body);
  if (wrap) body = wrap[1];

  body.split(/[\n;]+/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) return;

    // Edge statement (may be a chain): a -> b -> c  /  a <-> b  /  a -- b
    if (/(<->|->|--)/.test(line)) {
      const tokens = line.split(/\s*(<->|->|--)\s*/);
      // tokens: [id, op, id, op, id, ...]
      let ok = true;
      for (let k = 0; k < tokens.length; k += 2) {
        if (!new RegExp(`^${ID}$`).test(tokens[k])) { ok = false; break; }
      }
      if (ok && tokens.length >= 3) {
        for (let k = 0; k < tokens.length; k += 2) ensure(tokens[k]);
        for (let k = 1; k < tokens.length; k += 2) {
          const op = tokens[k], a = tokens[k - 1], b = tokens[k + 1];
          const style = op === '->' ? 'causal' : 'bidirected';
          addEdge(a, b, style);
        }
        return;
      }
      flags.push({ line: i + 1, why: `could not parse edge '${line}'` });
      return;
    }

    // Node declaration: ID [attr,attr,...]   or bare ID
    const nodeM = new RegExp(`^(${ID})\\s*(\\[(.*)\\])?$`).exec(line);
    if (nodeM) {
      const n = ensure(nodeM[1]);
      if (nodeM[3] != null && applyAttrs(n, nodeM[3], flags, i + 1)) placed.add(n.id);
      return;
    }
    flags.push({ line: i + 1, why: `could not parse '${line}'` });
  });

  return { model, flags, placed };
}

// -> true when the attributes state a position.
function applyAttrs(node, attrStr, flags, lineNo) {
  let hasPos = false;
  // Split on commas that are not inside quotes.
  const attrs = attrStr.match(/(?:[^,"]|"[^"]*")+/g) || [];
  for (const a of attrs.map((s) => s.trim()).filter(Boolean)) {
    const posM = /^pos\s*=\s*"?\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*"?$/.exec(a);
    if (posM) { node.x = parseFloat(posM[1]); node.y = parseFloat(posM[2]); hasPos = true; continue; }
    switch (a.toLowerCase()) {
      case 'exposure': node.role = 'exposure'; break;
      case 'outcome': node.role = 'outcome'; break;
      case 'adjusted': node.style = 'cond'; break;
      case 'latent':
      case 'unobserved': node.style = 'unobs'; node.role = 'latent'; break;
      case 'selected': node.role = 'collider'; break;
      default: flags.push({ line: lineNo, why: `unknown attribute '${a}'` });
    }
  }
  return hasPos;
}

export function emit(model) {
  const lines = ['dag {'];
  for (const n of model.nodes) {
    const attrs = [];
    if (n.role === 'exposure') attrs.push('exposure');
    if (n.role === 'outcome') attrs.push('outcome');
    if (n.style === 'cond') attrs.push('adjusted');
    if (n.style === 'unobs') attrs.push('latent');
    attrs.push(`pos="${fmt(n.x)},${fmt(n.y)}"`);
    lines.push(`  ${n.id} [${attrs.join(',')}]`);
  }
  for (const e of model.edges) {
    const op = e.style === 'bidirected' ? '<->' : '->';
    lines.push(`  ${e.from} ${op} ${e.to}`);
  }
  lines.push('}');
  return lines.join('\n');
}

function fmt(v) { return (Math.round(v * 1000) / 1000).toString(); }
