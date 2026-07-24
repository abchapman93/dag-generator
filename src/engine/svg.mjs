// model -> standalone SVG string. Two visual modes:
//   'manuscript' — the named-grammar look (rv = bare label, cond = rectangle,
//                  unobs = gray, regime = orange diamond); edge colours per style.
//   'informal'   — the colour-coded tutoring look (nodes coloured by semantic
//                  role, boxes with fills), matching the legacy skill palette.
// Pure string builder — no DOM. Used for SVG/HTML/PNG export and to seed the app
// canvas. Interactivity (drag) lives in the frontend, not here.

import { formatSwigLabel } from './swig.mjs';

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
  const swigStyle = opts.swigStyle || model.meta?.swigStyle || 'superscript';
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
  const nodeSVG = nodes.map((n) => renderNode(n, pos[n.id], mode, swigStyle)).join('\n');
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

// Flowchart family — decision/leaf boxes, rendered the same in both modes since
// their colour is the point (mirrors the TikZ decision/leaf/leafPos/leafNeg set).
const FLOW = {
  decision: { shape: 'rect', fill: '#ffffff', stroke: '#1a1c22', text: '#1a1c22', rx: 34, ry: 22 },
  leaf: { shape: 'rrect', fill: '#f3f4f6', stroke: '#6b7280', text: '#1a1c22', rx: 34, ry: 22 },
  leafPos: { shape: 'rrect', fill: '#dcf5e3', stroke: '#3a9d5d', text: '#14532d', rx: 34, ry: 22 },
  leafNeg: { shape: 'rrect', fill: '#fbdcdc', stroke: '#c0392b', text: '#7f1d1d', rx: 34, ry: 22 },
};

function visual(node, mode) {
  let v;
  if (FLOW[node.style]) {
    v = { ...FLOW[node.style] };
  } else if (mode === 'manuscript') {
    switch (node.style) {
      case 'cond': v = { shape: 'rect', fill: '#ffffff', stroke: '#1a1c22', text: '#1a1c22', rx: 18, ry: 16 }; break;
      case 'unobs': v = { shape: 'none', text: '#8a8f98', rx: 13, ry: 13 }; break;
      case 'regime': v = { shape: 'diamond', fill: '#ffffff', stroke: '#e07a1f', text: '#e07a1f', rx: 22, ry: 18 }; break;
      case 'fixed': v = { shape: 'none', text: '#e07a1f', rx: 13, ry: 13 }; break;
      default: v = { shape: 'none', text: '#1a1c22', rx: 13, ry: 13 };
    }
  } else if (node.style === 'regime') {
    v = { shape: 'diamond', fill: '#ffffff', stroke: '#e07a1f', text: '#e07a1f', rx: 24, ry: 19 };
  } else if (node.style === 'fixed') {
    v = { shape: 'none', text: '#e07a1f', rx: 13, ry: 13 };
  } else {
    // informal: colour by role, falling back to style.
    const key = node.role || (node.style === 'unobs' ? 'latent' : node.style === 'cond' ? 'cond' : 'rv');
    if (key === 'cond' || node.style === 'cond') {
      v = { shape: 'rect', fill: '#ffffff', stroke: '#1a1c22', text: '#1a1c22', rx: 30, ry: 22, doubled: true };
    } else {
      const c = INFORMAL[key];
      v = c ? { shape: 'rrect', fill: c.fill, stroke: c.stroke, text: '#1a1c22', rx: 30, ry: 22, dashed: c.dashed }
            : { shape: 'rrect', fill: '#ffffff', stroke: '#c9ced6', text: '#1a1c22', rx: 30, ry: 22 };
    }
  }

  // Per-node colour overrides (xcolor expressions -> hex, best effort). Setting a
  // fill/stroke on an otherwise-shapeless node promotes it to a rounded box so the
  // colour is visible.
  if (node.fill || node.stroke) {
    if (v.shape === 'none') { v.shape = 'rrect'; v.rx = v.rx || 30; v.ry = v.ry || 22; v.fill = v.fill || '#ffffff'; }
    const f = xcolorToHex(node.fill); if (f) v.fill = f;
    const s = xcolorToHex(node.stroke); if (s) v.stroke = s;
  }
  const t = xcolorToHex(node.text); if (t) v.text = t;
  return v;
}

// Minimal xcolor-expression -> hex. Handles a base palette, `name!pct` (mix with
// white) and `name!pct!other`. Returns null on anything it can't map, so callers
// keep their default colour rather than rendering wrong.
const XCOLOR = {
  red: '#ff0000', green: '#00ff00', blue: '#0000ff', cyan: '#00ffff', magenta: '#ff00ff',
  yellow: '#ffff00', orange: '#ff7f00', violet: '#800080', purple: '#bf0040', brown: '#bf8040',
  black: '#000000', white: '#ffffff', gray: '#808080', grey: '#808080', lime: '#bfff00',
  pink: '#ffbfbf', teal: '#008080', olive: '#808000',
};
export function xcolorToHex(expr) {
  if (expr == null) return null;
  const s = String(expr).trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
  const m = /^([a-zA-Z]+)(?:!(\d+(?:\.\d+)?))?(?:!([a-zA-Z]+))?$/.exec(s);
  if (!m) return null;
  const base = XCOLOR[m[1].toLowerCase()];
  if (!base) return null;
  if (m[2] == null) return base;
  const other = m[3] ? (XCOLOR[m[3].toLowerCase()] || '#ffffff') : '#ffffff';
  return mixHex(base, other, parseFloat(m[2]) / 100);
}
function mixHex(c1, c2, t) {
  const ch = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [r1, g1, b1] = ch(c1), [r2, g2, b2] = ch(c2);
  const q = (a, b) => Math.round(a * t + b * (1 - t)).toString(16).padStart(2, '0');
  return `#${q(r1, r2)}${q(g1, g2)}${q(b1, b2)}`;
}

function renderNode(node, p, mode, swigStyle) {
  const v = visual(node, mode);
  const label = `<text x="${round(p.x)}" y="${round(p.y)}" text-anchor="middle" dominant-baseline="central" font-style="italic" font-size="19" fill="${v.text}">${tex2disp(formatSwigLabel(node.label, swigStyle))}</text>`;
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

  let d, mid;
  if (e.bend) {
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    const k = Math.tan((e.bend * Math.PI / 180) / 2);
    const cx = mx - uy * len * k * 0.5, cy = my + ux * len * k * 0.5;
    d = `M${round(ax)},${round(ay)} Q${round(cx)},${round(cy)} ${round(bx)},${round(by)}`;
    mid = { x: 0.25 * ax + 0.5 * cx + 0.25 * bx, y: 0.25 * ay + 0.5 * cy + 0.25 * by }; // quad point at t=0.5
  } else {
    d = `M${round(ax)},${round(ay)} L${round(bx)},${round(by)}`;
    mid = { x: (ax + bx) / 2, y: (ay + by) / 2 };
  }
  const start = bidir ? ` marker-start="url(#mk-${e.style})"` : '';
  const path = `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.6"${dash} marker-end="url(#mk-${e.style})"${start}/>`;
  return path + renderEdgeLabel(e, mid);
}

// Branch-condition label near the edge midpoint, with a white halo (paint-order)
// so it stays legible where it crosses the line. labelPos keywords (above/below/
// left/right, TikZ's own) nudge it off the path.
function renderEdgeLabel(e, mid) {
  if (!e.label) return '';
  const pos = e.labelPos || 'above';
  let dx = 0, dy = -8, anchor = 'middle';
  if (/below/.test(pos)) dy = 15;
  if (/left/.test(pos)) { anchor = 'end'; dx = -7; if (!/above|below/.test(pos)) dy = 4; }
  else if (/right/.test(pos)) { anchor = 'start'; dx = 7; if (!/above|below/.test(pos)) dy = 4; }
  return `<text x="${round(mid.x + dx)}" y="${round(mid.y + dy)}" text-anchor="${anchor}" dominant-baseline="central" font-style="italic" font-size="14" fill="#3a3f47" paint-order="stroke" stroke="#ffffff" stroke-width="3" stroke-linejoin="round">${tex2disp(e.label)}</text>`;
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
