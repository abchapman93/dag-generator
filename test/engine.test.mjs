import { describe, it, expect } from 'vitest';
import * as formula from '../src/engine/formula.mjs';
import * as dagitty from '../src/engine/dagitty.mjs';
import * as tikz from '../src/engine/tikz.mjs';
import { layout } from '../src/engine/layout.mjs';
import { toSVG } from '../src/engine/svg.mjs';
import { toHTML } from '../src/engine/html.mjs';
import { intervene, formatSwigLabel } from '../src/engine/swig.mjs';
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

  it('emits a TikZ bend that curves the same way the SVG/canvas renderer does', () => {
    // A -> Y is a plain left-to-right edge. svg.mjs (which the app canvas
    // mirrors) sags a positive bend toward larger pixel-y, i.e. below the
    // line. TikZ's own "bend left" for a rightward edge curves *above* the
    // line (+y, since TikZ is y-up) — so a positive e.bend must map to
    // "bend right" in TikZ to reproduce the same visual sag. Regression test
    // for the app-canvas vs .tex-export mismatch bug.
    const m = emptyModel({ nodes: [{ id: 'A', x: 0, y: 0 }, { id: 'Y', x: 3, y: 0 }], edges: [{ from: 'A', to: 'Y', style: 'causal', bend: 20 }] });
    const svg = toSVG(m, { style: 'manuscript' });
    const path = /<path d="M([\d.]+),([\d.]+) Q([\d.]+),([\d.]+)/.exec(svg);
    expect(Number(path[4])).toBeGreaterThan(Number(path[2])); // control point below the baseline
    expect(tikz.emit(m)).toContain('bend right=20');
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

  it('parses a 2-arg splitbar as a SWIG intervention, preserving the fixed-node id', () => {
    const src = '\\node[rv](A) at (0,0) {$A$};\n\\splitbar{A}{A_v};\n\\node[fixed](A_v) at (0.4,0) {$a$};';
    const { model } = tikz.parse(src);
    expect(model.meta.kind).toBe('swig');
    expect(model.swig.interventions[0].node).toBe('A');
    expect(model.swig.interventions[0].regimeLabel).toBe('A_v');
  });

  it('round-trips a 2-arg splitbar through emit -> parse', () => {
    const m = emptyModel({
      nodes: [
        { id: 'A', x: 0, y: 0, label: '$A$' },
        { id: 'A_v', x: 0.4, y: 0, label: '$a$', style: 'fixed' },
      ],
      swig: { interventions: [{ node: 'A', regimeLabel: 'A_v' }] },
    });
    const tex = tikz.emit(m);
    expect(tex).toMatch(/\\splitbar\{A\}\{A_v\};/);
    const { model: back } = tikz.parse(tex);
    expect(back.swig.interventions[0]).toEqual({ node: 'A', regimeLabel: 'A_v' });
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
    // Y is relabelled with the potential-outcome argument, colored via \cfarg
    expect(m.nodes.find((n) => n.id === 'Y').label).toBe('$Y(\\cfarg{a})$');
    expect(m.swig.interventions[0].node).toBe('A');
  });

  it('emits a 2-arg splitbar (centered between the node and its fixed value) and round-trips through tikz', () => {
    const m = intervene(base(), 'A');
    const fixedId = m.swig.interventions[0].regimeLabel;
    const tex = tikz.emit(m);
    expect(tex).toMatch(new RegExp(`\\\\splitbar\\{A\\}\\{${fixedId}\\};`));
    expect(tex).toMatch(/\\node\[fixed\]/);
    const back = tikz.parse(tex).model;
    expect(back.meta.kind).toBe('swig');
    expect(back.nodes.some((n) => n.style === 'fixed')).toBe(true);
    expect(back.swig.interventions[0].regimeLabel).toBe(fixedId);
  });

  it('merges into an existing parenthetical instead of stacking a second one', () => {
    const m = formula.parse('exposure: A\noutcome: Y\nconfounder: L\nY ~ A + L\nA ~ L').model;
    m.nodes.find((n) => n.id === 'Y').label = '$Y(u)$';
    const swigged = intervene(layout(m), 'A');
    const label = swigged.nodes.find((n) => n.id === 'Y').label;
    expect(label).toBe('$Y(u, \\cfarg{a})$');
  });

  it('supports a two-part intervention with accumulated arguments in order', () => {
    // A -> M -> Y, A -> Y (M is itself intervened on, downstream of A)
    const m = layout(formula.parse('exposure: A\nmediator: M\noutcome: Y\nY ~ A + M\nM ~ A').model);
    const swigged = intervene(m, ['A', 'M']);
    expect(swigged.nodes.filter((n) => n.style === 'fixed').map((n) => n.label)).toEqual(['$a$', '$m$']);
    // M is a descendant of A, so its own (kept) node picks up A's argument
    expect(swigged.nodes.find((n) => n.id === 'M').label).toBe('$M(\\cfarg{a})$');
    // Y is downstream of both, in the order given
    expect(swigged.nodes.find((n) => n.id === 'Y').label).toBe('$Y(\\cfarg{a}, \\cfarg{m})$');
    expect(swigged.swig.interventions.map((iv) => iv.node)).toEqual(['A', 'M']);
  });

  it('wraps each accumulated argument in \\cfarg{...} (orange intervention-value coloring)', () => {
    const m = intervene(base(), 'A', { values: { A: 'a' } });
    expect(m.nodes.find((n) => n.id === 'Y').label).toBe('$Y(\\cfarg{a})$');
    // the fixed node's own label stays plain -- the `fixed` node style already renders orange
    expect(m.nodes.find((n) => n.style === 'fixed').label).toBe('$a$');
  });

  it('shifts every node downstream of the intervened node by delta, preserving relative order', () => {
    const m = base();
    const yBefore = m.nodes.find((n) => n.id === 'Y').x;
    const aBefore = m.nodes.find((n) => n.id === 'A').x;
    const swigged = intervene(m, 'A');
    const fixed = swigged.nodes.find((n) => n.style === 'fixed');
    const aAfter = swigged.nodes.find((n) => n.id === 'A').x;
    const yAfter = swigged.nodes.find((n) => n.id === 'Y').x;
    const DELTA = 0.4;
    expect(aAfter).toBe(aBefore); // the intervened node itself doesn't move
    expect(fixed.x).toBeCloseTo(aAfter + DELTA);
    expect(yAfter).toBeCloseTo(yBefore + DELTA);
    // no overlap / sane ordering: A < fixed value < Y
    expect(aAfter).toBeLessThan(fixed.x);
    expect(fixed.x).toBeLessThan(yAfter);
  });

  it('scales the split gap up when the intervened node already carries an argument (collision fix)', () => {
    // A -> M -> Y, A -> Y: by the time M is split, its own label already carries A's
    // argument ($M(\cfarg{a})$), visibly wider than a bare label. A flat gap placed the
    // fixed-value node close enough to overlap the wider label's text (confirmed by
    // actually compiling the exported TikZ to PDF and looking for the overlap, not just
    // by eyeballing the coordinate math) -- the gap must scale up for this case.
    const m = layout(formula.parse('exposure: A\nmediator: M\noutcome: Y\nY ~ A + M\nM ~ A').model);
    const mBefore = m.nodes.find((n) => n.id === 'M').x;
    const yBefore = m.nodes.find((n) => n.id === 'Y').x;
    const swigged = intervene(m, ['A', 'M']);

    expect(swigged.nodes.find((n) => n.id === 'M').label).toBe('$M(\\cfarg{a})$');

    const mAfter = swigged.nodes.find((n) => n.id === 'M').x;
    const yAfter = swigged.nodes.find((n) => n.id === 'Y').x;
    const aFixed = swigged.nodes.find((n) => n.id === 'A_v');
    const mFixed = swigged.nodes.find((n) => n.id === 'M_v');

    const plainGap = aFixed.x - swigged.nodes.find((n) => n.id === 'A').x; // A's label is bare
    const widenedGap = mFixed.x - mAfter; // M's label already carries an argument when split

    expect(mAfter).toBeCloseTo(mBefore + plainGap); // A's split shifted M by the plain gap
    expect(widenedGap).toBeGreaterThan(plainGap); // the fix: a wider label gets more room
    expect(yAfter).toBeCloseTo(yBefore + plainGap + widenedGap); // Y absorbs both shifts
    // sane, non-overlapping relative order
    expect(aFixed.x).toBeLessThan(mAfter);
    expect(mFixed.x).toBeLessThan(yAfter);
  });

  it('two sequential single-node interventions compose the same as one multi-node call', () => {
    // The app UI intervenes on one node at a time (per-click); this must match
    // intervene(model, ['A', 'M']) so the two paths render identically.
    const build = () => layout(formula.parse('exposure: A\nmediator: M\noutcome: Y\nY ~ A + M\nM ~ A').model);
    const sequential = intervene(intervene(build(), 'A'), 'M');
    const multi = intervene(build(), ['A', 'M']);
    const norm = (m) => ({
      nodes: m.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, style: n.style, label: n.label }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      edges: edgeSet(m),
      interventions: m.swig.interventions,
    });
    expect(norm(sequential)).toEqual(norm(multi));
  });

  it('keeps column-aligned rows aligned across two sequential interventions', () => {
    // A/X are roots on separate rows; H0/V0 are column-aligned with each other,
    // as are H1/V1 -- the property the shift algorithm exists to preserve.
    const m = emptyModel({
      nodes: [
        { id: 'A', x: 0, y: 0, label: '$A$' },
        { id: 'X', x: 0, y: 1, label: '$X$' },
        { id: 'H0', x: 1, y: 0, label: '$H_0$' },
        { id: 'V0', x: 1, y: 1, label: '$V_0$' },
        { id: 'H1', x: 2, y: 0, label: '$H_1$' },
        { id: 'V1', x: 2, y: 1, label: '$V_1$' },
      ],
      edges: [
        { from: 'A', to: 'H0', style: 'causal' },
        { from: 'X', to: 'V0', style: 'causal' },
        { from: 'H0', to: 'H1', style: 'causal' },
        { from: 'V0', to: 'V1', style: 'causal' },
      ],
    });
    const swigged = intervene(intervene(m, 'A'), 'V0');
    const at = (id) => swigged.nodes.find((n) => n.id === id).x;
    expect(at('H0')).toBe(at('V0'));
    expect(at('H1')).toBe(at('V1'));
  });

  it('formatSwigLabel reformats paren notation into superscript at render/emit time only', () => {
    expect(formatSwigLabel('$Y(\\cfarg{a})$', 'superscript')).toBe('$Y^{\\cfarg{a}}$');
    expect(formatSwigLabel('$Y(\\cfarg{a}, \\cfarg{m})$', 'superscript')).toBe('$Y^{\\cfarg{a}, \\cfarg{m}}$');
    // paren is the default and a no-op; labels with no argument list pass through untouched
    expect(formatSwigLabel('$Y(\\cfarg{a})$', 'paren')).toBe('$Y(\\cfarg{a})$');
    expect(formatSwigLabel('$a$', 'superscript')).toBe('$a$');
    expect(formatSwigLabel('$A$', 'superscript')).toBe('$A$');
    // a base that already ends in its own superscript (e.g. $H^{*}$, given as a
    // starting label before any intervention) must merge into that group rather
    // than stack a second ^{...} -- LaTeX errors on a double superscript.
    expect(formatSwigLabel('$H^{*}(\\cfarg{a})$', 'superscript')).toBe('$H^{*, \\cfarg{a}}$');
  });

  it('meta.swigStyle="superscript" changes tikz emit and SVG export, not the stored label', () => {
    const m = intervene(base(), 'A');
    expect(m.nodes.find((n) => n.id === 'Y').label).toBe('$Y(\\cfarg{a})$'); // stored form unaffected

    m.meta.swigStyle = 'superscript';
    expect(tikz.emit(m)).toMatch(/\\node\[rv\]\(Y\).*\{\$Y\^\{\\cfarg\{a\}\}\$\}/);
    expect(toSVG(m)).toContain("baseline-shift='super'");
    expect(toSVG(m)).toContain("<tspan fill='#e07a1f'>a</tspan>");

    // default ('paren') still emits the parenthetical form
    delete m.meta.swigStyle;
    expect(tikz.emit(m)).toMatch(/\{\$Y\(\\cfarg\{a\}\)\$\}/);
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
