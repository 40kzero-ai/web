import { describe, it, expect } from 'vitest';
import { topoSort, wouldCycle, downstream, upstream, stableStringify, type Graph } from './graph';

const g: Graph = {
  output: 'c',
  nodes: [
    { id: 'c', type: 'combine', x: 0, y: 0, params: {}, inputs: { a: { node: 'a', port: 'height' }, b: { node: 'b', port: 'height' }, mask: null } },
    { id: 'b', type: 'erosion', x: 0, y: 0, params: {}, inputs: { height: { node: 'a', port: 'height' } } },
    { id: 'a', type: 'perlin', x: 0, y: 0, params: {}, inputs: {} },
  ],
};

describe('graph', () => {
  it('sorts topologically', () => {
    const order = topoSort(g).map((n) => n.id);
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('c'));
  });
  it('detects cycles', () => {
    expect(wouldCycle(g, 'c', 'a')).toBe(true);
    expect(wouldCycle(g, 'a', 'c')).toBe(false);
    expect(wouldCycle(g, 'a', 'a')).toBe(true);
  });
  it('computes upstream/downstream', () => {
    expect([...upstream(g, 'c')].sort()).toEqual(['a', 'b', 'c']);
    expect([...downstream(g, 'a')].sort()).toEqual(['a', 'b', 'c']);
    expect([...downstream(g, 'b')].sort()).toEqual(['b', 'c']);
  });
  it('throws on cyclic graph', () => {
    const cyc: Graph = { output: null, nodes: [
      { id: 'x', type: 't', x: 0, y: 0, params: {}, inputs: { i: { node: 'y', port: 'h' } } },
      { id: 'y', type: 't', x: 0, y: 0, params: {}, inputs: { i: { node: 'x', port: 'h' } } },
    ] };
    expect(() => topoSort(cyc)).toThrow(/Cycle/);
  });
  it('stable stringify is key-order independent', () => {
    expect(stableStringify({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe(stableStringify({ a: [1, { c: 3, d: 2 }], b: 1 }));
  });
});
