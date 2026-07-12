import { describe, it, expect } from 'vitest';
import * as formula from '../src/engine/formula.mjs';
import * as dagitty from '../src/engine/dagitty.mjs';
import * as tikz from '../src/engine/tikz.mjs';
import { layout } from '../src/engine/layout.mjs';
import { toSVG } from '../src/engine/svg.mjs';
import { toHTML } from '../src/engine/html.mjs';
import { intervene } from '../src/engine/swig.mjs';
import { validate, emptyModel } from '../src/engine/model.mjs';

// helpers: compare graph structure ignoring coordinates
const edgeKey = (e) => `${e.from}->${e.to}:${e.style}`;
const edgeSet = (m) => new Set(m.edges.map(edgeKey));
const nodeMap = (m) => new Map(m.nodes.map((n) => [n.id, { style: n.style, role: n.role }]));

describe('formula parser', () => {
  it('parses the canonical example "A ~ L, Y ~ A + L"', () => {
    const { model, flags } = formula.parse('A ~ L, Y ~ A + L');
    expect(flags).toHaveLength(0);
    expect(new Set(model.nodes.map((n) => n.id))).toEqual(new Set(['A', 'L', 'Y']));
    expect(edgeSet(model)).toEqual(new Set(['L->A:causal', 'A->Y:causal', 'L->Y:causal']));
  });

  it('handles roles, unmeasured, adjusted, bidirected, arrow chains', () => {
    const src = [
      'exposure: A', 'outcome: Y', 'confounder: L', 'unmeasured: U', 'adjusted: C',
      'Y ~ A + L', 'A ~ L', 'U -> A', 'U <-> Uc', 'A -> M -> Y',
    ].join('\n');
    const { model, flags } = formula.parse(src);
    expect(flags).toHaveLength(0);
    const nm = nodeMap(model);
    expect(nm.get('A').role).toBe('exposure');
    expect(nm.get('Y').role).toBe('outcome');
    expect(nm.get('U').style).toBe('unobs');
    expect(nm.get('C').style).toBe('cond');
    expect(edgeSet(model).has('U->Uc:bidirected')).toBe(true);
    expect(edgeSet(model).has('A->M:causal')).toBe(true);
    expect(edgeSet(model).has('M->Y:causal')).toBe(true);
  });

  it('round-trips: parse -> emit -> parse preserves structure', () => {
    const src = 'exposure: A\noutcome: Y\nconfounder: L\nunmeasured: U\nY ~ A + L + U\nA ~ L + U';
    const a = formula.parse(src).model;
    const b = formula.parse(formula.emit(a)).model;
    expect(edgeSet(b)).toEqual(edgeSet(a));
    expect(nodeMap(b)).toEqual(nodeMap(a));
  });

  it('flags an unparseable statement', () => {
    const { flags } = formula.parse('A ~~ B @@');
    expect(flags.length).toBeGreaterThan(0);
  });
});

describe('dagitty', () => {
  it('parses a dag block with attributes and pos', () => {
    const src = `dag {
      A [exposure,pos="0,1"]
      Y [outcome,pos="3,1"]
      L [pos="1,2"]
      U [latent,pos="1,3"]
      L -> A
      A -> Y
      L -> Y
      U -> A
      U -> Y
    }`;
    const { model, flags } = dagitty.parse(src);
    expect(flags).toHaveLength(0);
    expect(model.nodes.find((n) => n.id === 'A').role).toBe('exposure');
    expect(model.nodes.find((n) => n.id === 'U').style).toBe('unobs');
    expect(model.nodes.find((n) => n.id === 'A').x).toBe(0);
    expect(edgeSet(model).has('U->A:causal')).toBe(true);
  });

  it('round-trips: emit -> parse preserves structure and coords', () => {
    const src = 'dag {\n  A [exposure,pos="0,1"]\n  Y [outcome,pos="2,1"]\n  A -> Y\n  X <-> Z\n}';
    const a = dagitty.parse(src).model;
    const b = dagitty.parse(dagitty.emit(a)).model;
    expect(edgeSet(b)).toEqual(edgeSet(a));
    expect(nodeMap(b)).toEqual(nodeMap(a));
    expect(b.nodes.find((n) => n.id === 'A').x).toBe(0);
  });

  it('formula and dagitty describe the same graph', () => {
    const f = formula.parse('exposure: A\noutcome: Y\nconfounder: L\nY ~ A + L\nA ~ L').model;
    const d = dagitty.parse('dag {\n A [exposure]\n Y [outcome]\n L\n L -> A\n A -> Y\n L -> Y\n}').model;
    expect(edgeSet(f)).toEqual(edgeSet(d));
  });
});

describe('tikz canonical grammar', () => {
  const triangle = () => layout(formula.parse('exposure: A\noutcome: Y\nconfounder: L\nY ~ A + L\nA ~ L').model);

  it('emits one node/edge per line in the named-style grammar', () => {
    const out = tikz.emit(triangle());
    expect(out).toMatch(/\\node\[rv\]\(A\) at \(-?\d/);
    expect(out).toMatch(/\\draw\[causal\] \(L\) to \(A\);/);
    expect(out.trim().startsWith('\\begin{tikzpicture}')).toBe(true);
  });

  it('round-trips: emit -> parse preserves nodes, edges, coords', () => {
    const a = triangle();
    const { model: b, flags } = tikz.parse(tikz.emit(a));
    expect(flags).toHaveLength(0);
    expect(edgeSet(b)).toEqual(edgeSet(a));
    for (const na of a.nodes) {
      const nb = b.nodes.find((n) => n.id === na.id);
      expect([nb.x, nb.y]).toEqual([na.x, na.y]);
      expect(nb.style).toBe(na.style);
    }
  });

  it('preserves bend directions', () => {
    const m = emptyModel({ nodes: [{ id: 'A', x: 0, y: 0 }, { id: 'Y', x: 3, y: 0 }], edges: [{ from: 'A', to: 'Y', style: 'causal', bend: 20 }] });
    const back = tikz.parse(tikz.emit(m)).model;
    expect(back.edges[0].bend).toBe(20);
    const m2 = { ...m, edges: [{ from: 'A', to: 'Y', style: 'causal', bend: -15 }] };
    expect(tikz.parse(tikz.emit(m2)).model.edges[0].bend).toBe(-15);
  });

  it('flags off-grammar constructs but keeps valid lines', () => {
    const src = [
      '\\begin{tikzpicture}',
      '\\node[rv](A) at (0,0) {$A$};',
      '\\node[weird](B) at (1,0) {$B$};',
      '\\path (A) edge (B);',
      '\\draw[causal] (A) to (B);',
      '\\end{tikzpicture}',
    ].join('\n');
    const { model, flags } = tikz.parse(src);
    expect(model.nodes.map((n) => n.id)).toContain('A');
    const reasons = flags.map((f) => f.why).join(' | ');
    expect(reasons).toMatch(/unknown node style 'weird'/);
    expect(reasons).toMatch(/unsupported construct/);
  });

  it('ignores standalone preamble incl. multi-line tikzset', () => {
    const src = tikz.emit(triangle(), { wrap: 'standalone' });
    const { model, flags } = tikz.parse(src);
    expect(flags).toHaveLength(0);
    expect(model.nodes.length).toBe(3);
  });

  it('parses a splitbar as a SWIG intervention', () => {
    const src = '\\node[rv](A) at (0,0) {$A$};\n\\splitbar{A};\n\\node[regime](G) at (1,0) {$G$};';
    const { model } = tikz.parse(src);
    expect(model.meta.kind).toBe('swig');
    expect(model.swig.interventions[0].node).toBe('A');
  });
});

describe('layout', () => {
  it('assigns integer grid coords, layered left->right by depth', () => {
    const m = layout(formula.parse('Y ~ A + L\nA ~ L\nM ~ A\nY ~ M').model);
    const at = (id) => m.nodes.find((n) => n.id === id);
    expect(Number.isInteger(at('L').x)).toBe(true);
    expect(at('L').x).toBeLessThan(at('A').x); // L is upstream of A
    expect(at('A').x).toBeLessThan(at('Y').x);
    m.nodes.forEach((n) => { expect(Number.isInteger(n.x)).toBe(true); expect(Number.isInteger(n.y)).toBe(true); });
  });
});

describe('svg / html', () => {
  it('renders an svg with a node label and an arrow marker', () => {
    const svg = toSVG(layout(formula.parse('exposure: A\noutcome: Y\nY ~ A').model), { style: 'informal' });
    expect(svg).toMatch(/<svg /);
    expect(svg).toContain('marker');
    expect(svg).toMatch(/<text[^>]*>A<\/text>/);
  });

  it('manuscript style draws rv nodes without a shape', () => {
    const m = layout(formula.parse('Y ~ A').model);
    const svg = toSVG(m, { style: 'manuscript' });
    // rv nodes: text present, but no <rect>/<polygon> around plain rv nodes
    expect(svg).toMatch(/<text/);
    expect(svg).not.toMatch(/<rect x=[^>]*fill="#dae8fc"/);
  });

  it('produces a self-contained html doc', () => {
    const html = toHTML(layout(formula.parse('exposure: A\noutcome: Y\nY ~ A').model), { style: 'informal' });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<svg');
    expect(html).toContain('Exposure');
  });
});

describe('swig transform', () => {
  const base = () => layout(formula.parse('exposure: A\noutcome: Y\nconfounder: L\nY ~ A + L\nA ~ L').model);

  it('splits the treatment into a fixed-value node with a cfedge, using potential-outcome notation', () => {
    const m = intervene(base(), 'A');
    expect(m.meta.kind).toBe('swig');
    const fixed = m.nodes.find((n) => n.style === 'fixed');
    expect(fixed).toBeTruthy();
    expect(fixed.label).toBe('$a$');
    // no reads edges: the fixed value has no incoming edges of its own
    expect(m.edges.some((e) => e.to === fixed.id)).toBe(false);
    expect(m.edges.some((e) => e.from === fixed.id && e.to === 'Y' && e.style === 'cfedge')).toBe(true);
    // the observed A -> Y causal edge is gone (the fixed value causes the counterfactual)
    expect(m.edges.some((e) => e.from === 'A' && e.to === 'Y' && e.style === 'causal')).toBe(false);
    // Y is relabelled with the potential-outcome argument
    expect(m.nodes.find((n) => n.id === 'Y').label).toBe('$Y(a)$');
    expect(m.swig.interventions[0].node).toBe('A');
  });

  it('emits a splitbar and round-trips through tikz', () => {
    const m = intervene(base(), 'A');
    const tex = tikz.emit(m);
    expect(tex).toMatch(/\\splitbar\{A\}/);
    expect(tex).toMatch(/\\node\[fixed\]/);
    const back = tikz.parse(tex).model;
    expect(back.meta.kind).toBe('swig');
    expect(back.nodes.some((n) => n.style === 'fixed')).toBe(true);
  });

  it('merges into an existing parenthetical instead of stacking a second one', () => {
    const m = formula.parse('exposure: A\noutcome: Y\nconfounder: L\nY ~ A + L\nA ~ L').model;
    m.nodes.find((n) => n.id === 'Y').label = '$Y(u)$';
    const swigged = intervene(layout(m), 'A');
    const label = swigged.nodes.find((n) => n.id === 'Y').label;
    expect(label).toBe('$Y(u, a)$');
  });

  it('supports a two-part intervention with accumulated arguments in order', () => {
    // A -> M -> Y, A -> Y (M is itself intervened on, downstream of A)
    const m = layout(formula.parse('exposure: A\nmediator: M\noutcome: Y\nY ~ A + M\nM ~ A').model);
    const swigged = intervene(m, ['A', 'M']);
    expect(swigged.nodes.filter((n) => n.style === 'fixed').map((n) => n.label)).toEqual(['$a$', '$m$']);
    // M is a descendant of A, so its own (kept) node picks up A's argument
    expect(swigged.nodes.find((n) => n.id === 'M').label).toBe('$M(a)$');
    // Y is downstream of both, in the order given
    expect(swigged.nodes.find((n) => n.id === 'Y').label).toBe('$Y(a, m)$');
    expect(swigged.swig.interventions.map((iv) => iv.node)).toEqual(['A', 'M']);
  });
});

describe('model validation', () => {
  it('detects cycles as a warning', () => {
    const m = formula.parse('A ~ B\nB ~ A').model;
    const v = validate(m);
    expect(v.warnings.join()).toMatch(/cycle/);
  });
  it('reports duplicate ids and unknown styles', () => {
    const m = emptyModel();
    m.nodes.push({ id: 'A', style: 'bogus' }, { id: 'A', style: 'rv' });
    const v = validate(m);
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toMatch(/duplicate node id 'A'/);
    expect(v.errors.join()).toMatch(/unknown style 'bogus'/);
  });
});
