import { describe, it, expect } from 'vitest';
import * as formula from '../src/engine/formula.mjs';
import * as dagitty from '../src/engine/dagitty.mjs';
import * as tikz from '../src/engine/tikz.mjs';
import { carryOver, FORMULA, DAGITTY } from '../src/engine/merge.mjs';

const pos = (m) => Object.fromEntries(m.nodes.map((n) => [n.id, [n.x, n.y]]));
const node = (m, id) => m.nodes.find((n) => n.id === id);
const edge = (m, from, to) => m.edges.find((e) => e.from === from && e.to === to);

// An arrangement no auto-layout would produce, with attributes the formula
// DSL cannot express.
const arranged = () => tikz.parse([
  '\\node[rv](L) at (4,3) {$L$};',
  '\\node[rv, fill=green!15](A) at (0,-2) {Treatment};',
  '\\node[rv](Y) at (9,-2) {$Y$};',
  '\\draw[causal] (L) to (A);',
  '\\draw[causal] (L) to (Y);',
  '\\draw[causal] (A) to[bend left=30] (Y);',
].join('\n')).model;

// What the app does when a text panel is edited.
const edit = (prev, text, dialect = FORMULA, memory) => {
  const r = (dialect === FORMULA ? formula : dagitty).parse(text);
  return carryOver(prev, r.model, { ...dialect, placed: r.placed, memory });
};

describe('carryOver: a text-panel edit keeps the arrangement', () => {
  it('adding a variable in the formula leaves every existing node where it was', () => {
    const prev = arranged();
    const next = edit(prev, formula.emit(prev) + '\nM ~ A\nY ~ M');
    expect(pos(next)).toMatchObject(pos(prev));
    expect(node(next, 'M')).toBeTruthy();
    expect(edge(next, 'M', 'Y')).toBeTruthy();
  });

  it('places the new node on a free cell, not on a node or a straight edge', () => {
    const prev = arranged();
    const next = edit(prev, formula.emit(prev) + '\nM ~ L\nY ~ M');
    const cells = next.nodes.map((n) => `${n.x},${n.y}`);
    expect(new Set(cells).size).toBe(cells.length);
    expect(Number.isInteger(node(next, 'M').x)).toBe(true);
  });

  it('keeps what the formula cannot say: labels, colours, bends', () => {
    const prev = arranged();
    const next = edit(prev, formula.emit(prev) + '\nM ~ A');
    expect(node(next, 'A').label).toBe('Treatment');
    expect(node(next, 'A').fill).toBe('green!15');
    expect(edge(next, 'A', 'Y').bend).toBe(edge(prev, 'A', 'Y').bend);
    expect(edge(next, 'A', 'Y').bend).not.toBe(0);
  });

  it('keeps node and edge styles the formula has no keyword for', () => {
    const prev = arranged();
    node(prev, 'A').style = 'regime';
    edge(prev, 'L', 'Y').style = 'det';
    prev.edges.push({ from: 'A', to: 'L', style: 'biasing', bend: 0 });
    const next = edit(prev, formula.emit(prev) + '\nM ~ A');
    expect(node(next, 'A').style).toBe('regime');
    expect(edge(next, 'L', 'Y').style).toBe('det');
    expect(edge(next, 'A', 'L')?.style).toBe('biasing');
  });

  it('the text still wins on what it does say', () => {
    const prev = arranged();
    node(prev, 'L').style = 'cond';
    const next = edit(prev, 'exposure: A\nA ~ L');   // no `adjusted:`, no Y
    expect(node(next, 'L').style).toBe('rv');
    expect(node(next, 'A').role).toBe('exposure');
    expect(node(next, 'Y')).toBeUndefined();
    expect(next.edges).toHaveLength(1);
  });

  it('keeps meta and SWIG interventions for nodes that survive', () => {
    const prev = arranged();
    prev.meta.title = 'Paper 1'; prev.meta.kind = 'swig';
    prev.swig = { interventions: [{ node: 'A', regimeLabel: 'a' }, { node: 'Y', regimeLabel: 'y' }] };
    const next = edit(prev, 'A ~ L');
    expect(next.meta.title).toBe('Paper 1');
    expect(next.swig.interventions).toEqual([{ node: 'A', regimeLabel: 'a' }]);
  });

  it('a node that drops out mid-edit comes back where it was', () => {
    const prev = arranged();
    const memory = new Map();
    const mid = edit(prev, 'A ~ L', FORMULA, memory);          // the Y line is half-typed
    expect(node(mid, 'Y')).toBeUndefined();
    const back = edit(mid, 'A ~ L\nY ~ L + A', FORMULA, memory);
    expect(pos(back)).toEqual(pos(prev));
    expect(edge(back, 'A', 'Y').bend).toBe(edge(prev, 'A', 'Y').bend);
  });

  it('a wholly new graph gets the automatic layout', () => {
    const next = edit(arranged(), 'P ~ Q\nR ~ P');
    expect(new Set(next.nodes.map((n) => n.x)).size).toBe(3);   // layered, not stacked at 0,0
  });

  it('an empty previous model gets the automatic layout', () => {
    const next = edit({ meta: {}, nodes: [], edges: [] }, 'A ~ L, Y ~ A + L');
    expect(new Set(next.nodes.map((n) => `${n.x},${n.y}`)).size).toBe(3);
  });
});

describe('carryOver: dagitty', () => {
  it('a node added without pos is placed; a pos in the text is obeyed', () => {
    const prev = arranged();
    const text = dagitty.emit(prev).replace('L [pos="4,3"]', 'L [pos="5,5"]').replace(/\}\s*$/, '  M\n  A -> M\n  M -> Y\n}');
    const next = edit(prev, text, DAGITTY);
    expect(pos(next).L).toEqual([5, 5]);
    expect(pos(next).A).toEqual(pos(prev).A);
    const cells = next.nodes.map((n) => `${n.x},${n.y}`);
    expect(new Set(cells).size).toBe(cells.length);
    expect(pos(next).M).not.toEqual([0, 0]);
  });

  it('keeps roles and labels dagitty cannot say', () => {
    const prev = arranged();
    node(prev, 'L').role = 'confounder';
    const next = edit(prev, dagitty.emit(prev), DAGITTY);
    expect(node(next, 'L').role).toBe('confounder');
    expect(node(next, 'A').label).toBe('Treatment');
    expect(edge(next, 'A', 'Y').bend).not.toBe(0);
  });
});
