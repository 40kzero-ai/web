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
  world: {
    label: 'Game world (zones → erosion → rivers → sea)',
    build: () => make([
      { id: 'cont', type: 'shape', x: 40, y: 20, params: { kind: 'square', size: 1.1, falloff: 0.45, distort: 0.3, seed: 4 } },
      { id: 'ctrlN', type: 'perlin', x: 40, y: 150, params: { seed: 31, scale: 1.3, octaves: 4, gain: 0.5, warp: 0.5 } },
      { id: 'ctrl', type: 'combine', x: 270, y: 60, params: { mode: 'multiply', ratio: 1 }, inputs: { a: 'ctrlN', b: 'cont' } },
      { id: 'low', type: 'hills', x: 270, y: 180, params: { seed: 8, scale: 6, relief: 1, base: 0 } },
      { id: 'mid', type: 'hills', x: 270, y: 290, params: { seed: 9, scale: 4, roundness: 0.3, relief: 1, base: 0 } },
      { id: 'mtn', type: 'mountain', x: 270, y: 400, params: { seed: 7, scale: 2.5, stretch: 2.2, angle: 35, bulk: 0.4 } },
      { id: 'zone', type: 'zonemix', x: 520, y: 120, params: { t1: 0.3, t2: 0.55, softness: 0.12, lowBase: 0.16, lowRelief: 0.08, midBase: 0.18, midRelief: 0.28, highBase: 0.25, highRelief: 0.75 }, inputs: { control: 'ctrl', low: 'low', mid: 'mid', high: 'mtn' } },
      { id: 'land', type: 'combine', x: 640, y: 260, params: { mode: 'multiply', ratio: 1 }, inputs: { a: 'zone', b: 'cont' } },
      { id: 'flu', type: 'fluvial', x: 760, y: 20, params: { rounds: 10, steps: 8, strength: 0.5, diffusion: 0.04 }, inputs: { height: 'land' } },
      { id: 'ero', type: 'erosion', x: 760, y: 150, params: { droplets: 8 }, inputs: { height: 'flu:height' } },
      { id: 'flow', type: 'flow', x: 1000, y: 120, params: { contrast: 1.5 }, inputs: { height: 'ero:height' } },
      { id: 'riv', type: 'rivers', x: 1240, y: 120, params: { threshold: 0.6 }, inputs: { height: 'ero:height', flow: 'flow:flow' } },
      { id: 'sea', type: 'sea', x: 1480, y: 120, params: { level: 0.09 }, inputs: { height: 'riv:height' } },
      { id: 'water', type: 'combine', x: 1480, y: 260, params: { mode: 'max', ratio: 1 }, inputs: { a: 'sea:water', b: 'riv:rivers' } },
      { id: 'water2', type: 'combine', x: 1700, y: 260, params: { mode: 'max', ratio: 1 }, inputs: { a: 'water', b: 'flow:lakes' } },
      { id: 'sat', type: 'satmap', x: 1940, y: 120, params: { preset: 'alpine', snowLine: 0.8, flowTint: 0.35 }, inputs: { height: 'sea:height', flow: 'flow:flow', water: 'water2' } },
    ], 'sat'),
  },
  alpine: {
    label: 'Alpine range (Mountain → Erosion → SatMap)',
    build: () => make([
      { id: 'mtn', type: 'mountain', x: 40, y: 60, params: { seed: 7, scale: 1.8, bulk: 0.6, warp: 0.3, stretch: 2, angle: 25 } },
      { id: 'flu', type: 'fluvial', x: 280, y: 60, params: { rounds: 10, steps: 8, strength: 0.5, diffusion: 0.04 }, inputs: { height: 'mtn' } },
      { id: 'ero', type: 'erosion', x: 520, y: 60, params: { droplets: 8 }, inputs: { height: 'flu:height' } },
      { id: 'sat', type: 'satmap', x: 780, y: 40, params: { preset: 'alpine', snowLine: 0.72 }, inputs: { height: 'ero:height', flow: 'ero:flow' } },
    ], 'sat'),
  },
  canyon: {
    label: 'Canyon (Terrace → Warp → Erosion)',
    build: () => make([
      { id: 'per', type: 'perlin', x: 40, y: 40, params: { seed: 21, scale: 1.2, octaves: 6, gain: 0.45, warp: 0.6 } },
      { id: 'ter', type: 'terrace', x: 260, y: 40, params: { steps: 9, sharpness: 0.85, uniformity: 0.55 }, inputs: { height: 'per' } },
      { id: 'wrp', type: 'warp', x: 470, y: 40, params: { strength: 0.02, scale: 6, seed: 3 }, inputs: { height: 'ter' } },
      { id: 'ero', type: 'erosion', x: 680, y: 40, params: { droplets: 8, deposit: 0.55 }, inputs: { height: 'wrp' } },
      { id: 'sat', type: 'satmap', x: 920, y: 40, params: { preset: 'canyon', snowLine: 1.5, rockAngle: 50 }, inputs: { height: 'ero:height', flow: 'ero:flow' } },
    ], 'sat'),
  },
  island: {
    label: 'Volcanic island (Volcano + lowlands → Fluvial → Sea)',
    build: () => make([
      { id: 'vol', type: 'volcano', x: 40, y: 20, params: { seed: 2, radius: 0.34, concavity: 2.2, crater: 0.08, ridges: 0.4, secondary: 0.35 } },
      { id: 'isle', type: 'shape', x: 40, y: 150, params: { kind: 'circle', size: 0.95, falloff: 0.5, distort: 0.3, seed: 9 } },
      { id: 'low', type: 'hills', x: 40, y: 280, params: { seed: 5, scale: 5, relief: 1, base: 0 } },
      { id: 'lowland', type: 'combine', x: 270, y: 200, params: { mode: 'multiply', ratio: 1 }, inputs: { a: 'low', b: 'isle' } },
      { id: 'lowAdj', type: 'adjust', x: 270, y: 300, params: { multiply: 0.22, add: 0.0 }, inputs: { height: 'lowland' } },
      { id: 'volAdj', type: 'adjust', x: 270, y: 40, params: { multiply: 0.85, add: 0.08 }, inputs: { height: 'vol' } },
      { id: 'volIsle', type: 'combine', x: 480, y: 40, params: { mode: 'multiply', ratio: 1 }, inputs: { a: 'volAdj', b: 'isle' } },
      { id: 'land', type: 'combine', x: 700, y: 100, params: { mode: 'max', ratio: 1 }, inputs: { a: 'volIsle', b: 'lowAdj' } },
      { id: 'flu', type: 'fluvial', x: 920, y: 100, params: { rounds: 10, steps: 8, strength: 0.45, diffusion: 0.04 }, inputs: { height: 'land' } },
      { id: 'ero', type: 'erosion', x: 1160, y: 100, params: { droplets: 8 }, inputs: { height: 'flu:height' } },
      { id: 'flow', type: 'flow', x: 1400, y: 100, params: { contrast: 1.5 }, inputs: { height: 'ero:height' } },
      { id: 'riv', type: 'rivers', x: 1640, y: 100, params: { threshold: 0.62, depth: 0.012, valleyDepth: 0.012 }, inputs: { height: 'ero:height', flow: 'flow:flow' } },
      { id: 'sea', type: 'sea', x: 1880, y: 100, params: { level: 0.1, seabed: 0.4 }, inputs: { height: 'riv:height' } },
      { id: 'water', type: 'combine', x: 1880, y: 240, params: { mode: 'max', ratio: 1 }, inputs: { a: 'sea:water', b: 'riv:rivers' } },
      { id: 'sat', type: 'satmap', x: 2120, y: 100, params: { preset: 'volcanic', snowLine: 1.5, rockAngle: 32, flowTint: 0.3 }, inputs: { height: 'sea:height', flow: 'flow:flow', water: 'water' } },
    ], 'sat'),
  },
  masks: {
    label: 'Data maps demo (Slope / Flow mixing)',
    build: () => make([
      { id: 'mtn', type: 'mountain', x: 40, y: 60, params: { seed: 12, scale: 1.8 } },
      { id: 'ero', type: 'erosion', x: 280, y: 60, params: { droplets: 8 }, inputs: { height: 'mtn' } },
      { id: 'slope', type: 'slope', x: 520, y: 200, params: { minAngle: 30, falloff: 12 }, inputs: { height: 'ero:height' } },
      { id: 'satA', type: 'satmap', x: 520, y: 20, params: { preset: 'tundra', rockStrength: 0 }, inputs: { height: 'ero:height', flow: 'ero:flow' } },
      { id: 'satB', type: 'satmap', x: 520, y: 110, params: { preset: 'volcanic', rockStrength: 0, snowLine: 1.5 }, inputs: { height: 'ero:height' } },
      { id: 'mix', type: 'mixer', x: 780, y: 60, params: { ratio: 1 }, inputs: { a: 'satA:color', b: 'satB:color', mask: 'slope', height: 'ero:height' } },
    ], 'mix'),
  },
};
