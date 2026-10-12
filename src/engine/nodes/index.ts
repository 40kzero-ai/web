import type { NodeDef } from '../types';
import { PRIMITIVES } from './primitives';
import { EROSION_NODES } from './erosion';
import { MODIFIERS } from './modifiers';
import { DATA_NODES } from './data';
import { COLOR_NODES } from './color';

export const ALL_NODES: NodeDef[] = [...PRIMITIVES, ...EROSION_NODES, ...MODIFIERS, ...DATA_NODES, ...COLOR_NODES];
export const NODE_DEFS = new Map(ALL_NODES.map((d) => [d.type, d]));

export function nodeDef(type: string): NodeDef {
  const d = NODE_DEFS.get(type);
  if (!d) throw new Error(`Unknown node type: ${type}`);
  return d;
}
