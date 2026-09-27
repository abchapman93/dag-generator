import { describe, it, expect } from 'vitest';
import * as formula from '../src/engine/formula.mjs';
import { layout } from '../src/engine/layout.mjs';
import { diffModels, applyPatch, describeOps, touchedHandles, placeNodes } from '../src/engine/patch.mjs';
import { formatHandle, parseHandle, resolveHandles } from '../src/engine/handles.mjs';

const build = (src) => layout(formula.parse(src).model);
const edgeSet = (m) => new Set(m.edges.map((e) => `${e.from}->${e.to}:${e.style}`));
const nodeSet = (m) => new Set(m.nodes.map((n) => n.id));

const FIXTURES = [
  ['A ~ L, Y ~ A + L', 'A ~ L, Y ~ A + L + M, M ~ A'],
  ['A ~ L, Y ~ A + L', 'Y ~ A'],
  ['exposure: A\noutcome: Y\nY ~ A + L\nA ~ L\nU <-> L', 'exposure: A\noutcome: Y\nY ~ A + L + C\nA ~ L + C\nU -> L'],
  ['A -> M -> Y\nA -> Y', 'A -> Y\nM -> Y'],
];

describe('handles', () => {
  it('round-trips node and edge handles, including ids with dashes', () => {
    for (const item of [{ type: 'node', id: 'L-1' }, { type: 'edge', from: 'L-1', to: 'Y' }, { type: 'edge', from: 'A', to: 'B-2' }]) {
      expect(parseHandle(formatHandle(item))).toEqual(item);
    }
  });
  it('rejects non-dag handles', () => {
    expect(parseHandle('@text:1-4')).toBeNull();
    expect(parseHandle('@edge:A')).toBeNull();
    expect(parseHandle('@node:')).toBeNull();
  });
  it('resolves against a model and reports what no longer matches', () => {
    const m = build('Y ~ A + L');
    const { found, missing } = resolveHandles(m, ['@node:A', '@edge:L->Y', '@node:Z', '@edge:Y->A']);
    expect(found).toEqual([{ type: 'node', id: 'A' }, { type: 'edge', index: m.edges.findIndex((e) => e.from === 'L' && e.to === 'Y') }]);
    expect(missing).toEqual(['@node:Z', '@edge:Y->A']);
  });
});

describe('patch', () => {
  it('applyPatch(a, diffModels(a, b)) reproduces b', () => {
    for (const [sa, sb] of FIXTURES) {
      const a = build(sa), b = build(sb);
      const { model, conflicts } = applyPatch(a, diffModels(a, b));
      expect(conflicts).toEqual([]);
      expect(nodeSet(model)).toEqual(nodeSet(b));
      expect(edgeSet(model)).toEqual(edgeSet(b));
    }
  });

  it('is all-or-nothing: a conflict leaves the input untouched', () => {
    const a = build('Y ~ A + L');
    const snapshot = JSON.stringify(a);
    const { model, conflicts } = applyPatch(a, [
      { op: 'add-node', node: { id: 'M' } },
      { op: 'remove-edge', from: 'Y', to: 'A' },
    ]);
    expect(conflicts).toEqual(['edge Y → A is not in the DAG']);
    expect(model).toBe(a);
    expect(JSON.stringify(a)).toBe(snapshot);
  });

  it('flags each conflict kind', () => {
    const a = build('Y ~ A + L');
    const c = (ops) => applyPatch(a, ops).conflicts;
    expect(c([{ op: 'add-node', node: { id: 'A' } }])).toEqual(["node 'A' already exists"]);
    expect(c([{ op: 'remove-node', id: 'Z' }])).toEqual(["node 'Z' is not in the DAG"]);
    expect(c([{ op: 'set-node', id: 'Z', set: { label: 'z' } }])).toEqual(["node 'Z' is not in the DAG"]);
    expect(c([{ op: 'set-node', id: 'A', set: { id: 'B' } }])).toEqual(["node 'A': cannot set 'id'"]);
    expect(c([{ op: 'add-edge', edge: { from: 'A', to: 'Y' } }])).toEqual(['edge A → Y already exists']);
    expect(c([{ op: 'add-edge', edge: { from: 'A', to: 'Q' } }])).toEqual(["edge references missing node 'Q'"]);
    expect(c([{ op: 'frobnicate' }])).toEqual(["unknown op 'frobnicate'"]);
    expect(c([])).toEqual(['the patch has no ops']);
    expect(c([{ op: 'add-edge', edge: { from: 'Y', to: 'A' } }])[0]).toMatch(/the patch creates a directed cycle/);
  });

  it('removing a node takes its edges with it', () => {
    const a = build('Y ~ A + L, A ~ L');
    const { model } = applyPatch(a, [{ op: 'remove-node', id: 'L' }]);
    expect(edgeSet(model)).toEqual(new Set(['A->Y:causal']));
  });

  it('places new nodes on free integer cells near their neighbours', () => {
    const a = build('Y ~ A + L, A ~ L');
    const { model } = applyPatch(a, [
      { op: 'add-node', node: { id: 'M' } },
      { op: 'add-node', node: { id: 'N' } },
      { op: 'add-edge', edge: { from: 'A', to: 'M' } },
      { op: 'add-edge', edge: { from: 'M', to: 'Y' } },
      { op: 'add-edge', edge: { from: 'A', to: 'N' } },
    ]);
    const cells = model.nodes.map((n) => `${n.x},${n.y}`);
    expect(new Set(cells).size).toBe(cells.length);
    for (const n of model.nodes) expect(Number.isInteger(n.x) && Number.isInteger(n.y)).toBe(true);
    // Existing nodes don't move.
    for (const n of a.nodes) expect(model.nodes.find((m) => m.id === n.id)).toMatchObject({ x: n.x, y: n.y });
  });

  it('keeps explicit coordinates when a new node has them', () => {
    const a = build('Y ~ A');
    const { model } = applyPatch(a, [{ op: 'add-node', node: { id: 'Q', x: 7, y: 3 } }]);
    expect(model.nodes.find((n) => n.id === 'Q')).toMatchObject({ x: 7, y: 3 });
  });

  it('placeNodes is deterministic', () => {
    const mk = () => { const m = build('Y ~ A'); m.nodes.push({ id: 'Z', x: NaN, y: NaN, style: 'rv', label: 'Z' }); return placeNodes(m, new Set(['Z'])); };
    expect(mk().nodes.find((n) => n.id === 'Z')).toEqual(mk().nodes.find((n) => n.id === 'Z'));
  });

  it('diff ignores positions and narrowed fields unless asked', () => {
    const a = build('Y ~ A');
    const b = JSON.parse(JSON.stringify(a));
    b.nodes[0].x += 3;
    b.nodes[0].label = 'Renamed';
    expect(diffModels(a, b, { nodeFields: [] })).toEqual([]);
    expect(diffModels(a, b)).toEqual([{ op: 'set-node', id: b.nodes[0].id, set: { label: 'Renamed' } }]);
    expect(diffModels(a, b, { nodeFields: [], positions: true })).toEqual([{ op: 'set-node', id: b.nodes[0].id, set: { x: b.nodes[0].x } }]);
  });

  it('describes ops and names the existing things they touch', () => {
    const a = build('Y ~ A + L');
    const ops = [
      { op: 'add-node', node: { id: 'M' } },
      { op: 'add-edge', edge: { from: 'A', to: 'M' } },
      { op: 'remove-edge', from: 'L', to: 'Y' },
      { op: 'set-edge', from: 'A', to: 'Y', set: { style: 'bidirected' } },
    ];
    expect(describeOps(ops, a).map((d) => d.sign)).toEqual(['+', '+', '−', '~']);
    expect(describeOps(ops, a)[3].text).toBe('edge A → Y: style "causal" → "bidirected"');
    expect(touchedHandles(ops, a)).toEqual(['@node:A', '@edge:L->Y', '@edge:A->Y']);
  });
});
