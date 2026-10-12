import type { Graph, NodeInstance } from '../engine/graph';
import { nodeDef } from '../engine/nodes';
import { defaultParams } from '../engine/types';

type Spec = { id: string; type: string; x: number; y: number; params?: Record<string, number | string | boolean>; inputs?: Record<string, string> };

function make(specs: Spec[], output: string): Graph {
  const nodes: NodeInstance[] = specs.map((s) => {
    const def = nodeDef(s.type);
    const inputs: Record<string, { node: string; port: string } | null> = {};
    for (const p of def.inputs) {
      const ref = s.inputs?.[p.key];
      if (ref) {
        const [node, port] = ref.split(':');
        inputs[p.key] = { node, port: port ?? 'height' };
      } else inputs[p.key] = null;
    }
    return { id: s.id, type: s.type, x: s.x, y: s.y, params: { ...defaultParams(def), ...(s.params ?? {}) }, inputs };
  });
  return { nodes, output };
}

export const PRESETS: Record<string, { label: string; build: () => Graph }> = {
  alpine: {
    label: 'Alpine range (Mountain → Erosion → SatMap)',
    build: () => make([
      { id: 'mtn', type: 'mountain', x: 40, y: 60, params: { seed: 7, scale: 1.6, bulk: 0.7, warp: 0.4 } },
      { id: 'ero', type: 'erosion', x: 280, y: 60, params: { iterations: 500, rain: 0.6, softness: 0.55, downcutting: 0.4 }, inputs: { height: 'mtn' } },
      { id: 'sat', type: 'satmap', x: 540, y: 40, params: { preset: 'alpine', snowLine: 0.72 }, inputs: { height: 'ero:height', flow: 'ero:flow' } },
    ], 'sat'),
  },
  canyon: {
    label: 'Canyon (Terrace → Warp → Erosion)',
    build: () => make([
      { id: 'per', type: 'perlin', x: 40, y: 40, params: { seed: 21, scale: 1.2, octaves: 6, gain: 0.45, warp: 0.6 } },
      { id: 'ter', type: 'terrace', x: 260, y: 40, params: { steps: 9, sharpness: 0.85, uniformity: 0.55 }, inputs: { height: 'per' } },
      { id: 'wrp', type: 'warp', x: 470, y: 40, params: { strength: 0.02, scale: 6, seed: 3 }, inputs: { height: 'ter' } },
      { id: 'ero', type: 'erosion', x: 680, y: 40, params: { iterations: 350, rain: 0.4, softness: 0.35, deposition: 0.6, thermal: 0.35, talusAngle: 45 }, inputs: { height: 'wrp' } },
      { id: 'sat', type: 'satmap', x: 920, y: 40, params: { preset: 'canyon', snowLine: 1.5, rockAngle: 50 }, inputs: { height: 'ero:height', flow: 'ero:flow' } },
    ], 'sat'),
  },
  island: {
    label: 'Volcanic island (Shape × Mountain)',
    build: () => make([
      { id: 'shape', type: 'shape', x: 40, y: 160, params: { size: 0.7, falloff: 0.35, distort: 0.2, seed: 9 } },
      { id: 'mtn', type: 'mountain', x: 40, y: 20, params: { seed: 3, scale: 2.2, bulk: 0.4, peaks: 1.1 } },
      { id: 'mul', type: 'combine', x: 280, y: 60, params: { mode: 'multiply', ratio: 1 }, inputs: { a: 'mtn', b: 'shape' } },
      { id: 'ero', type: 'erosion', x: 500, y: 60, params: { iterations: 450, rain: 0.7, softness: 0.6, thermal: 0.3 }, inputs: { height: 'mul' } },
      { id: 'sat', type: 'satmap', x: 740, y: 40, params: { preset: 'volcanic', snowLine: 1.5, rockAngle: 35 }, inputs: { height: 'ero:height', flow: 'ero:flow' } },
    ], 'sat'),
  },
  masks: {
    label: 'Data maps demo (Slope / Flow mixing)',
    build: () => make([
      { id: 'mtn', type: 'mountain', x: 40, y: 60, params: { seed: 12, scale: 1.8 } },
      { id: 'ero', type: 'erosion', x: 280, y: 60, params: { iterations: 400 }, inputs: { height: 'mtn' } },
      { id: 'slope', type: 'slope', x: 520, y: 200, params: { minAngle: 30, falloff: 12 }, inputs: { height: 'ero:height' } },
      { id: 'satA', type: 'satmap', x: 520, y: 20, params: { preset: 'tundra', rockStrength: 0 }, inputs: { height: 'ero:height', flow: 'ero:flow' } },
      { id: 'satB', type: 'satmap', x: 520, y: 110, params: { preset: 'volcanic', rockStrength: 0, snowLine: 1.5 }, inputs: { height: 'ero:height' } },
      { id: 'mix', type: 'mixer', x: 780, y: 60, params: { ratio: 1 }, inputs: { a: 'satA:color', b: 'satB:color', mask: 'slope', height: 'ero:height' } },
    ], 'mix'),
  },
};
