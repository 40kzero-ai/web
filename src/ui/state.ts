import type { Graph, NodeInstance, PortRef } from '../engine/graph';
import { newId } from '../engine/graph';
import { nodeDef } from '../engine/nodes';
import { defaultParams } from '../engine/types';

export interface Settings {
  width: number;
  height: number;
  heightRatio: number;
  budgetSec: number;
  autoPreview: boolean;
  previewWidth: number;
  view: '2d' | '3d';
  /** World seed; every node's seed is offset by it. */
  worldSeed: number;
}

type Listener = () => void;

export class AppState {
  graph: Graph = { nodes: [], output: null };
  selected: string | null = null;
  /** Output port of the selected node that is displayed. */
  viewPort = 'height';
  settings: Settings = {
    width: 4000,
    height: 2500,
    heightRatio: 0.22,
    budgetSec: 20,
    autoPreview: true,
    previewWidth: 1024,
    view: '3d',
    worldSeed: 1337,
  };
  private listeners = new Map<string, Set<Listener>>();

  on(event: 'graph' | 'selection' | 'settings' | 'view', fn: Listener): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  emit(event: 'graph' | 'selection' | 'settings' | 'view'): void {
    this.listeners.get(event)?.forEach((fn) => fn());
  }

  node(id: string | null): NodeInstance | undefined {
    return id ? this.graph.nodes.find((n) => n.id === id) : undefined;
  }

  addNode(type: string, x: number, y: number): NodeInstance {
    const def = nodeDef(type);
    const n: NodeInstance = { id: newId(), type, x, y, params: defaultParams(def), inputs: {} };
    for (const p of def.inputs) n.inputs[p.key] = null;
    this.graph.nodes.push(n);
    if (!this.graph.output) this.graph.output = n.id;
    this.emit('graph');
    return n;
  }

  removeNode(id: string): void {
    this.graph.nodes = this.graph.nodes.filter((n) => n.id !== id);
    for (const n of this.graph.nodes) {
      for (const [k, ref] of Object.entries(n.inputs)) if (ref && ref.node === id) n.inputs[k] = null;
    }
    if (this.graph.output === id) this.graph.output = this.graph.nodes[this.graph.nodes.length - 1]?.id ?? null;
    if (this.selected === id) this.select(this.graph.output);
    this.emit('graph');
  }

  connect(from: PortRef, toNode: string, toPort: string): void {
    const n = this.node(toNode);
    if (!n) return;
    n.inputs[toPort] = from;
    this.emit('graph');
  }

  disconnect(toNode: string, toPort: string): void {
    const n = this.node(toNode);
    if (!n || !n.inputs[toPort]) return;
    n.inputs[toPort] = null;
    this.emit('graph');
  }

  setParam(id: string, key: string, value: number | string | boolean): void {
    const n = this.node(id);
    if (!n || n.params[key] === value) return;
    n.params[key] = value;
    this.emit('graph');
  }

  select(id: string | null, port?: string): void {
    const n = this.node(id);
    this.selected = n ? id : null;
    if (n) {
      const def = nodeDef(n.type);
      this.viewPort = port && def.outputs.some((o) => o.key === port) ? port : def.outputs[0].key;
    }
    this.emit('selection');
  }

  setOutput(id: string): void {
    this.graph.output = id;
    this.emit('graph');
  }

  loadGraph(g: Graph): void {
    // Validate node types; drop unknown.
    const nodes = g.nodes.filter((n) => { try { nodeDef(n.type); return true; } catch { return false; } });
    for (const n of nodes) {
      const def = nodeDef(n.type);
      n.params = { ...defaultParams(def), ...n.params };
      const inputs: Record<string, PortRef | null> = {};
      for (const p of def.inputs) inputs[p.key] = n.inputs?.[p.key] ?? null;
      n.inputs = inputs;
    }
    this.graph = { nodes, output: g.output && nodes.some((n) => n.id === g.output) ? g.output : nodes[nodes.length - 1]?.id ?? null };
    this.emit('graph');
    this.select(this.graph.output);
  }

  updateSettings(patch: Partial<Settings>): void {
    Object.assign(this.settings, patch);
    this.emit('settings');
  }
}
