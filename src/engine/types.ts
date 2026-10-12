import type { Tex } from '../gl/texture';
import type { Engine } from './engine';
import type { ParamDef, PortDef } from './graph';

export type Params = Record<string, number | string | boolean>;

export interface EvalOptions {
  /** Build resolution. */
  width: number;
  height: number;
  /** Vertical scale: terrain height range as a fraction of map width (in world units). */
  heightRatio: number;
  /** performance.now() timestamp after which heavy nodes should stop iterating. */
  deadline: number;
  /** Share of remaining time this node may use (0..1). */
  timeShare: number;
  progress: (fraction: number, message: string) => void;
  /** Set when the build was cancelled. */
  cancelled: () => boolean;
  /** Preview builds trade quality for speed. */
  preview: boolean;
}

export interface NodeOutputs {
  [port: string]: Tex;
}

export interface NodeDef {
  type: string;
  title: string;
  category: 'Primitive' | 'Erosion' | 'Modifier' | 'Data' | 'Color' | 'Utility';
  description: string;
  inputs: PortDef[];
  outputs: PortDef[];
  params: ParamDef[];
  /** Heavy nodes report their relative cost so the time budget can be shared. */
  heavy?: boolean;
  evaluate(engine: Engine, inputs: Record<string, Tex | null>, params: Params, opts: EvalOptions): Promise<NodeOutputs> | NodeOutputs;
}

export function defaultParams(def: NodeDef): Params {
  const p: Params = {};
  for (const d of def.params) p[d.key] = d.default;
  return p;
}
