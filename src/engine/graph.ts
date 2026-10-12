/** Node-graph data model (pure, no WebGL). */

export type PortKind = 'height' | 'color';

export interface PortRef {
  node: string;
  port: string;
}

export interface NodeInstance {
  id: string;
  type: string;
  x: number;
  y: number;
  params: Record<string, number | string | boolean>;
  /** input key -> upstream output ref */
  inputs: Record<string, PortRef | null>;
}

export interface Graph {
  nodes: NodeInstance[];
  /** Node displayed in the viewport and used for export. */
  output: string | null;
}

export interface ParamDef {
  key: string;
  label: string;
  type: 'float' | 'int' | 'select' | 'bool' | 'seed';
  default: number | string | boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  /** Short help text shown in the properties panel. */
  hint?: string;
}

export interface PortDef {
  key: string;
  label: string;
  kind: PortKind;
  optional?: boolean;
}

export function topoSort(graph: Graph): NodeInstance[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const state = new Map<string, 0 | 1 | 2>();
  const order: NodeInstance[] = [];
  const visit = (n: NodeInstance, stack: string[]) => {
    const s = state.get(n.id);
    if (s === 2) return;
    if (s === 1) throw new Error(`Cycle detected through node ${[...stack, n.id].join(' -> ')}`);
    state.set(n.id, 1);
    for (const ref of Object.values(n.inputs)) {
      if (!ref) continue;
      const up = byId.get(ref.node);
      if (up) visit(up, [...stack, n.id]);
    }
    state.set(n.id, 2);
    order.push(n);
  };
  for (const n of graph.nodes) visit(n, []);
  return order;
}

/** Ids of the node and everything upstream of it. */
export function upstream(graph: Graph, id: string): Set<string> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out = new Set<string>();
  const walk = (nid: string) => {
    if (out.has(nid)) return;
    const n = byId.get(nid);
    if (!n) return;
    out.add(nid);
    for (const ref of Object.values(n.inputs)) if (ref) walk(ref.node);
  };
  walk(id);
  return out;
}

/** Would connecting from->to create a cycle? */
export function wouldCycle(graph: Graph, from: string, to: string): boolean {
  if (from === to) return true;
  return upstream(graph, from).has(to);
}

/** Ids of the node and everything downstream of it. */
export function downstream(graph: Graph, id: string): Set<string> {
  const out = new Set<string>([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of graph.nodes) {
      if (out.has(n.id)) continue;
      for (const ref of Object.values(n.inputs)) {
        if (ref && out.has(ref.node)) {
          out.add(n.id);
          changed = true;
          break;
        }
      }
    }
  }
  return out;
}

let counter = 0;
export function newId(prefix = 'n'): string {
  counter++;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
}

/** Stable string for cache keys. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}
