import type { Tex } from '../gl/texture';
import { Engine } from './engine';
import { topoSort, upstream, stableStringify, type Graph, type NodeInstance } from './graph';
import { nodeDef } from './nodes';
import type { NodeOutputs } from './types';

export interface BuildSettings {
  width: number;
  height: number;
  /** Terrain height range as a fraction of map width. */
  heightRatio: number;
  /** Wall-clock budget in ms; heavy nodes shorten their iterations to fit. */
  budgetMs: number;
  preview: boolean;
}

export interface BuildResult {
  /** Outputs of every evaluated node. */
  outputs: Map<string, NodeOutputs>;
  timeMs: number;
  evaluated: string[];
  notes: string[];
}

interface CacheEntry {
  key: string;
  outputs: NodeOutputs;
}

/** Evaluates a graph with per-node memoisation so only changed nodes recompute. */
export class Builder {
  private cache = new Map<string, CacheEntry>();
  private cancelFlag = false;
  building = false;
  onProgress: (fraction: number, message: string) => void = () => {};

  constructor(readonly engine: Engine) {}

  cancel(): void {
    this.cancelFlag = true;
  }

  /** Drop cached outputs for nodes no longer in the graph (or all of them). */
  invalidate(keepIds?: Set<string>): void {
    for (const [id, entry] of this.cache) {
      if (keepIds && keepIds.has(id)) continue;
      for (const t of Object.values(entry.outputs)) this.engine.release(t);
      this.cache.delete(id);
    }
  }

  getOutputs(nodeId: string): NodeOutputs | undefined {
    return this.cache.get(nodeId)?.outputs;
  }

  async build(graph: Graph, settings: BuildSettings, targetId: string | null): Promise<BuildResult> {
    if (this.building) throw new Error('A build is already running');
    this.building = true;
    this.cancelFlag = false;
    const start = performance.now();
    const notes: string[] = [];
    try {
      const order = topoSort(graph);
      const wanted = targetId ? upstream(graph, targetId) : new Set(graph.nodes.map((n) => n.id));
      const todo = order.filter((n) => wanted.has(n.id));
      // Keys in topo order (input keys feed downstream keys).
      const keys = new Map<string, string>();
      const dirty: NodeInstance[] = [];
      for (const n of todo) {
        const inputKeys: Record<string, string | null> = {};
        for (const [k, ref] of Object.entries(n.inputs)) inputKeys[k] = ref ? `${keys.get(ref.node) ?? 'missing'}#${ref.port}` : null;
        const key = stableStringify({ t: n.type, p: n.params, i: inputKeys, w: settings.width, h: settings.height, r: settings.heightRatio, pv: settings.preview });
        keys.set(n.id, key);
        const cached = this.cache.get(n.id);
        if (!cached || cached.key !== key) dirty.push(n);
      }
      // Time budget shared among heavy nodes that need recomputation.
      const reserveMs = Math.min(1500, settings.budgetMs * 0.1);
      const deadline = start + settings.budgetMs - reserveMs;
      let heavyLeft = dirty.filter((n) => nodeDef(n.type).heavy).length;
      const evaluated: string[] = [];
      for (let idx = 0; idx < todo.length; idx++) {
        const n = todo[idx];
        const def = nodeDef(n.type);
        const key = keys.get(n.id)!;
        const cached = this.cache.get(n.id);
        if (cached && cached.key === key) continue;
        if (this.cancelFlag) throw new Error('cancelled');
        const inputs: Record<string, Tex | null> = {};
        for (const port of def.inputs) {
          const ref = n.inputs[port.key];
          const tex = ref ? this.cache.get(ref.node)?.outputs[ref.port] ?? null : null;
          if (!tex && !port.optional) throw new Error(`${def.title}: input "${port.label}" is not connected`);
          inputs[port.key] = tex;
        }
        const baseProgress = idx / todo.length;
        this.onProgress(baseProgress, `${def.title}…`);
        const outputs = await def.evaluate(this.engine, inputs, n.params, {
          width: settings.width,
          height: settings.height,
          heightRatio: settings.heightRatio,
          deadline,
          timeShare: def.heavy ? 1 / Math.max(heavyLeft, 1) : 1,
          preview: settings.preview,
          cancelled: () => this.cancelFlag,
          progress: (f, msg) => {
            if (f >= 1 && msg.includes('budget')) notes.push(`${def.title}: ${msg}`);
            this.onProgress(baseProgress + f / todo.length, `${def.title}: ${msg}`);
          },
        });
        if (def.heavy) heavyLeft--;
        if (cached) for (const t of Object.values(cached.outputs)) this.engine.release(t);
        this.cache.set(n.id, { key, outputs });
        evaluated.push(n.id);
      }
      // Drop cache entries for deleted nodes.
      this.invalidate(new Set(graph.nodes.map((n) => n.id)));
      const outputs = new Map<string, NodeOutputs>();
      for (const n of todo) outputs.set(n.id, this.cache.get(n.id)!.outputs);
      await this.engine.sync();
      return { outputs, timeMs: performance.now() - start, evaluated, notes };
    } finally {
      this.building = false;
    }
  }
}
