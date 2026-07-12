// model -> standalone SVG string. Two visual modes:
//   'manuscript' — the named-grammar look (rv = bare label, cond = rectangle,
//                  unobs = gray, regime = orange diamond); edge colours per style.
//   'informal'   — the colour-coded tutoring look (nodes coloured by semantic
//                  role, boxes with fills), matching the legacy skill palette.
// Pure string builder — no DOM. Used for SVG/HTML/PNG export and to seed the app
// canvas. Interactivity (drag) lives in the frontend, not here.

const CELL = 70; // px per grid unit
const PAD = 46;

const INFORMAL = {
  exposure: { fill: '#dae8fc', stroke: '#6c8ebf' },
  outcome: { fill: '#fff2cc', stroke: '#d6b656' },
  confounder: { fill: '#d5e8d4', stroke: '#82b366' },
  covariate: { fill: '#d5e8d4', stroke: '#82b366' },
  collider: { fill: '#f8d7da', stroke: '#c0392b' },
  mediator: { fill: '#e1d5e7', stroke: '#9673a6' },
  latent: { fill: '#f0f0f0', stroke: '#999999', dashed: true },
};
const EDGE_COLOR = {
  causal: '#555555', det: '#555555', reads: '#e07a1f', cfedge: '#e07a1f',
  biasing: '#c0392b', blocked: '#888888', bidirected: '#8a8f98',
};

export function toSVG(model, opts = {}) {
  const mode = opts.style || model.meta?.style || 'informal';
  const cell = opts.cell || CELL;
  const nodes = model.nodes;

  const ext = extents(nodes);
  const W = (ext.maxx - ext.minx) * cell + PAD * 2;
  const H = (ext.maxy - ext.miny) * cell + PAD * 2;
  const px = (x) => PAD + (x - ext.minx) * cell;
  const py = (y) => PAD + (ext.maxy - y) * cell; // y up
  const pos = {};
  nodes.forEach((n) => (pos[n.id] = { x: px(n.x), y: py(n.y) }));

  const used = new Set(model.edges.map((e) => e.style));
  const defs = [...used].map((s) => marker(s, EDGE_COLOR[s] || '#555')).join('');

  const edgeSVG = model.edges.map((e) => renderEdge(e, pos, nodes, mode)).join('\n');
  const nodeSVG = nodes.map((n) => renderNode(n, pos[n.id], mode)).join('\n');
  const splitSVG = (model.swig?.interventions || [])
    .map((iv) => renderSplitbar(pos[iv.node], pos[iv.regimeLabel]))
    .join('\n');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${round(W)} ${round(H)}" width="${round(W)}" height="${round(H)}" font-family="Georgia, 'Times New Roman', serif">`,
    `<defs>${defs}</defs>`,
    `<rect width="100%" height="100%" fill="${opts.background || 'transparent'}"/>`,
    edgeSVG,
    nodeSVG,
    splitSVG,
    '</svg>',
  ].join('\n');
}

function extents(nodes) {
  if (!nodes.length) return { minx: 0, maxx: 3, miny: 0, maxy: 2 };
  const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
  return { minx: Math.min(...xs), maxx: Math.max(...xs), miny: Math.min(...ys), maxy: Math.max(...ys) };
}

function visual(node, mode) {
  if (mode === 'manuscript') {
    switch (node.style) {
      case 'cond': return { shape: 'rect', fill: '#ffffff', stroke: '#1a1c22', text: '#1a1c22', rx: 18, ry: 16 };
      case 'unobs': return { shape: 'none', text: '#8a8f98', rx: 13, ry: 13 };
      case 'regime': return { shape: 'diamond', fill: '#ffffff', stroke: '#e07a1f', text: '#e07a1f', rx: 22, ry: 18 };
      case 'fixed': return { shape: 'none', text: '#e07a1f', rx: 13, ry: 13 };
      default: return { shape: 'none', text: '#1a1c22', rx: 13, ry: 13 };
    }
  }
  // informal: colour by role, falling back to style.
  if (node.style === 'regime') return { shape: 'diamond', fill: '#ffffff', stroke: '#e07a1f', text: '#e07a1f', rx: 24, ry: 19 };
  if (node.style === 'fixed') return { shape: 'none', text: '#e07a1f', rx: 13, ry: 13 };
  const key = node.role || (node.style === 'unobs' ? 'latent' : node.style === 'cond' ? 'cond' : 'rv');
  if (key === 'cond' || node.style === 'cond') {
    return { shape: 'rect', fill: '#ffffff', stroke: '#1a1c22', text: '#1a1c22', rx: 30, ry: 22, doubled: true };
  }
  const c = INFORMAL[key];
  if (c) return { shape: 'rrect', fill: c.fill, stroke: c.stroke, text: '#1a1c22', rx: 30, ry: 22, dashed: c.dashed };
  return { shape: 'rrect', fill: '#ffffff', stroke: '#c9ced6', text: '#1a1c22', rx: 30, ry: 22 };
}

function renderNode(node, p, mode) {
  const v = visual(node, mode);
  const label = `<text x="${round(p.x)}" y="${round(p.y)}" text-anchor="middle" dominant-baseline="central" font-style="italic" font-size="19" fill="${v.text}">${tex2disp(node.label)}</text>`;
  let shape = '';
  const sw = 1.6;
  const dash = v.dashed ? ' stroke-dasharray="5 4"' : '';
  if (v.shape === 'rect' || v.shape === 'rrect') {
    const r = v.shape === 'rrect' ? 8 : 2;
    shape = `<rect x="${round(p.x - v.rx)}" y="${round(p.y - v.ry)}" width="${round(v.rx * 2)}" height="${round(v.ry * 2)}" rx="${r}" fill="${v.fill}" stroke="${v.stroke}" stroke-width="${sw}"${dash}/>`;
    if (v.doubled) shape += `<rect x="${round(p.x - v.rx + 3)}" y="${round(p.y - v.ry + 3)}" width="${round(v.rx * 2 - 6)}" height="${round(v.ry * 2 - 6)}" rx="${r}" fill="none" stroke="${v.stroke}" stroke-width="1"/>`;
  } else if (v.shape === 'diamond') {
    shape = `<polygon points="${round(p.x)},${round(p.y - v.ry)} ${round(p.x + v.rx)},${round(p.y)} ${round(p.x)},${round(p.y + v.ry)} ${round(p.x - v.rx)},${round(p.y)}" fill="${v.fill}" stroke="${v.stroke}" stroke-width="${sw}"/>`;
  }
  return `<g data-id="${node.id}">${shape}${label}</g>`;
}

function renderEdge(e, pos, nodes, mode) {
  const a = pos[e.from], b = pos[e.to];
  if (!a || !b) return '';
  const vA = visual(nodeById(nodes, e.from), mode);
  const vB = visual(nodeById(nodes, e.to), mode);
  const color = EDGE_COLOR[e.style] || '#555';
  const dash = (e.style === 'reads' || e.style === 'blocked' || e.style === 'bidirected') ? ' stroke-dasharray="6 4"' : '';
  const bidir = e.style === 'bidirected';

  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const [ax, ay] = trim(a, ux, uy, vA);
  const [bx, by] = trim(b, -ux, -uy, vB);

  let d;
  if (e.bend) {
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    const k = Math.tan((e.bend * Math.PI / 180) / 2);
    const cx = mx - uy * len * k * 0.5, cy = my + ux * len * k * 0.5;
    d = `M${round(ax)},${round(ay)} Q${round(cx)},${round(cy)} ${round(bx)},${round(by)}`;
  } else {
    d = `M${round(ax)},${round(ay)} L${round(bx)},${round(by)}`;
  }
  const start = bidir ? ` marker-start="url(#mk-${e.style})"` : '';
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.6"${dash} marker-end="url(#mk-${e.style})"${start}/>`;
}

function trim(p, ux, uy, v) {
  // approximate node boundary as an ellipse of radii (rx,ry); step out along (ux,uy)
  const rx = (v.rx || 13) + 2, ry = (v.ry || 13) + 2;
  const t = 1 / Math.sqrt((ux * ux) / (rx * rx) + (uy * uy) / (ry * ry) || 1);
  return [p.x + ux * t, p.y + uy * t];
}

function nodeById(nodes, id) { return nodes.find((n) => n.id === id) || { style: 'rv' }; }

// Vertical orange bar centered between the rv node and its fixed-value node,
// marking the SWIG split (mirrors the 2-arg \splitbar in tikz/dag-styles.tex).
function renderSplitbar(a, b) {
  if (!a || !b) return '';
  const x = round((a.x + b.x) / 2);
  return `<line x1="${x}" y1="${round(a.y - 16)}" x2="${x}" y2="${round(a.y + 16)}" stroke="#e07a1f" stroke-width="2.2"/>`;
}

function marker(style, color) {
  return `<marker id="mk-${style}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${color}"/></marker>`;
}

// Minimal LaTeX-ish label -> SVG tspans (subscripts, superscripts, \boldsymbol).
export function tex2disp(s) {
  s = String(s).replace(/^\$/, '').replace(/\$$/, '').replace(/\\boldsymbol\{([^}]*)\}/g, '$1').replace(/\\bar\{([^}]*)\}/g, '$1');
  s = s.replace(/\\cfarg\{([^}]*)\}/g, "<tspan fill='#e07a1f'>$1</tspan>");
  s = s
    .replace(/\^\{([^}]*)\}/g, "<tspan baseline-shift='super' font-size='0.7em'>$1</tspan>")
    .replace(/\^(\w)/g, "<tspan baseline-shift='super' font-size='0.7em'>$1</tspan>")
    .replace(/_\{([^}]*)\}/g, "<tspan baseline-shift='sub' font-size='0.7em'>$1</tspan>")
    .replace(/_(\w)/g, "<tspan baseline-shift='sub' font-size='0.7em'>$1</tspan>");
  return s;
}

function round(v) { return Math.round(v * 100) / 100; }
