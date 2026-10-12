import { HEADER, SAMPLING, NOISE } from '../../shaders/common';
import type { NodeDef, Params } from '../types';
import type { Engine } from '../engine';
import type { Tex } from '../../gl/texture';

const COMMON_PARAMS = (scale = 4) => [
  { key: 'seed', label: 'Seed', type: 'seed', default: 1, min: 0, max: 99999, step: 1 } as const,
  { key: 'scale', label: 'Scale', type: 'float', default: scale, min: 0.25, max: 64, step: 0.25, hint: 'Number of features across the map width' } as const,
  { key: 'offsetX', label: 'Offset X', type: 'float', default: 0, min: -100, max: 100, step: 0.01 } as const,
  { key: 'offsetY', label: 'Offset Y', type: 'float', default: 0, min: -100, max: 100, step: 0.01 } as const,
];

/** Shared uniform setup for primitives (aspect-corrected coordinates). */
function baseUniforms(p: Params, w: number, h: number) {
  return {
    uSeed: Number(p.seed) | 0,
    uScale: Number(p.scale),
    uOffset: [Number(p.offsetX ?? 0), Number(p.offsetY ?? 0)],
    uAspect: w / h,
  };
}

const COORD = `
uniform int uSeed; uniform float uScale; uniform vec2 uOffset; uniform float uAspect;
vec2 coord() { return (vec2(vUv.x * uAspect, vUv.y) + uOffset) * uScale; }
`;

function finish(engine: Engine, raw: Tex, autolevel: boolean): Tex {
  if (!autolevel) return raw;
  const out = engine.normalize(raw);
  engine.release(raw);
  return out;
}

export const PerlinNode: NodeDef = {
  type: 'perlin',
  title: 'Perlin',
  category: 'Primitive',
  description: 'Fractal gradient noise (fBm). Variants: Standard, Billow, Ridged.',
  inputs: [],
  outputs: [{ key: 'height', label: 'Out', kind: 'height' }],
  params: [
    { key: 'variant', label: 'Type', type: 'select', default: 'standard', options: [
      { value: 'standard', label: 'Standard' }, { value: 'billow', label: 'Billow' }, { value: 'ridged', label: 'Ridged' }] },
    ...COMMON_PARAMS(4),
    { key: 'octaves', label: 'Octaves', type: 'int', default: 8, min: 1, max: 16, step: 1 },
    { key: 'lacunarity', label: 'Lacunarity', type: 'float', default: 2.0, min: 1.2, max: 4, step: 0.05 },
    { key: 'gain', label: 'Persistence', type: 'float', default: 0.5, min: 0.1, max: 0.9, step: 0.01 },
    { key: 'warp', label: 'Warp', type: 'float', default: 0, min: 0, max: 2, step: 0.01, hint: 'Domain warp amount' },
    { key: 'autolevel', label: 'Autolevel', type: 'bool', default: true },
  ],
  evaluate(engine, _inputs, p, o) {
    const out = engine.alloc(o.width, o.height, 'R32F');
    engine.run('perlin', () => `${HEADER}${SAMPLING}${NOISE}${COORD}
uniform int uOctaves; uniform float uLac; uniform float uGain; uniform int uVariant; uniform float uWarp;
out vec4 o;
void main() {
  vec2 p = coord();
  if (uWarp > 0.0) p += uWarp * warpVec(p * 0.5, 4, uint(uSeed) + 999u);
  float sum = 0.0, amp = 1.0, norm = 0.0;
  uint seed = uint(uSeed);
  for (int i = 0; i < 16; i++) {
    if (i >= uOctaves) break;
    float n = perlin(p, seed + uint(i) * 131u);
    if (uVariant == 1) n = abs(n) * 2.0 - 1.0;
    else if (uVariant == 2) { n = 1.0 - abs(n); n = n * n * 2.0 - 1.0; }
    sum += n * amp; norm += amp; amp *= uGain;
    p = p * uLac + vec2(13.1, 7.7);
  }
  o = vec4(sum / norm * 0.5 + 0.5, 0.0, 0.0, 1.0);
}`, {
      ...baseUniforms(p, o.width, o.height),
      uOctaves: Number(p.octaves) | 0, uLac: Number(p.lacunarity), uGain: Number(p.gain),
      uVariant: p.variant === 'billow' ? 1 : p.variant === 'ridged' ? 2 : 0, uWarp: Number(p.warp),
    }, out);
    return { height: finish(engine, out, !!p.autolevel) };
  },
};

export const MountainNode: NodeDef = {
  type: 'mountain',
  title: 'Mountain',
  category: 'Primitive',
  description: 'Ridged multifractal mountains with bulk shaping and domain warp — a good base for erosion.',
  inputs: [],
  outputs: [{ key: 'height', label: 'Out', kind: 'height' }],
  params: [
    ...COMMON_PARAMS(2),
    { key: 'octaves', label: 'Octaves', type: 'int', default: 10, min: 1, max: 16, step: 1 },
    { key: 'gain', label: 'Persistence', type: 'float', default: 0.5, min: 0.2, max: 0.9, step: 0.01 },
    { key: 'sharpness', label: 'Ridge sharpness', type: 'float', default: 1.6, min: 0.5, max: 4, step: 0.05 },
    { key: 'bulk', label: 'Bulk', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, hint: 'Large scale mass variation' },
    { key: 'warp', label: 'Warp', type: 'float', default: 0.35, min: 0, max: 2, step: 0.01 },
    { key: 'peaks', label: 'Peak emphasis', type: 'float', default: 1.3, min: 0.5, max: 3, step: 0.05, hint: 'Power curve applied to the result' },
    { key: 'autolevel', label: 'Autolevel', type: 'bool', default: true },
  ],
  evaluate(engine, _inputs, p, o) {
    const out = engine.alloc(o.width, o.height, 'R32F');
    engine.run('mountain', () => `${HEADER}${SAMPLING}${NOISE}${COORD}
uniform int uOctaves; uniform float uGain; uniform float uSharp; uniform float uBulk; uniform float uWarp; uniform float uPeaks;
out vec4 o;
void main() {
  vec2 p = coord();
  uint seed = uint(uSeed);
  if (uWarp > 0.0) p += uWarp * warpVec(p * 0.6, 3, seed + 777u);
  float sum = 0.0, amp = 1.0, norm = 0.0, weight = 1.0;
  vec2 q = p;
  for (int i = 0; i < 16; i++) {
    if (i >= uOctaves) break;
    float n = perlin(q, seed + uint(i) * 131u);
    n = 1.0 - abs(n);
    n = pow(max(n, 0.0), uSharp);
    n *= weight;
    weight = clamp(n * 2.0, 0.0, 1.0);
    sum += n * amp; norm += amp; amp *= uGain;
    q = q * 2.03 + vec2(5.2, 1.3);
  }
  float ridged = sum / norm;
  float bulk = fbm(p * 0.45 + 3.7, 4, 2.0, 0.5, seed + 55u) * 0.5 + 0.5;
  float h = ridged * mix(1.0, bulk * 1.2, uBulk);
  o = vec4(pow(max(h, 0.0), uPeaks), 0.0, 0.0, 1.0);
}`, {
      ...baseUniforms(p, o.width, o.height),
      uOctaves: Number(p.octaves) | 0, uGain: Number(p.gain), uSharp: Number(p.sharpness),
      uBulk: Number(p.bulk), uWarp: Number(p.warp), uPeaks: Number(p.peaks),
    }, out);
    return { height: finish(engine, out, !!p.autolevel) };
  },
};

export const VoronoiNode: NodeDef = {
  type: 'voronoi',
  title: 'Voronoi',
  category: 'Primitive',
  description: 'Cellular noise: F1 / F2 distances, cell ids, or crisp edges. Multiple octaves add detail.',
  inputs: [],
  outputs: [{ key: 'height', label: 'Out', kind: 'height' }],
  params: [
    { key: 'func', label: 'Function', type: 'select', default: 'f1', options: [
      { value: 'f1', label: 'F1 (cells)' }, { value: 'f2', label: 'F2' }, { value: 'f2f1', label: 'F2 - F1 (ridges)' },
      { value: 'id', label: 'Cell ID (flat)' }, { value: 'edge', label: 'Edge distance' }] },
    ...COMMON_PARAMS(6),
    { key: 'jitter', label: 'Jitter', type: 'float', default: 1, min: 0, max: 1, step: 0.01 },
    { key: 'octaves', label: 'Octaves', type: 'int', default: 1, min: 1, max: 6, step: 1 },
    { key: 'gain', label: 'Persistence', type: 'float', default: 0.5, min: 0.1, max: 0.9, step: 0.01 },
    { key: 'invert', label: 'Invert', type: 'bool', default: true },
    { key: 'autolevel', label: 'Autolevel', type: 'bool', default: true },
  ],
  evaluate(engine, _inputs, p, o) {
    const out = engine.alloc(o.width, o.height, 'R32F');
    const funcs: Record<string, number> = { f1: 0, f2: 1, f2f1: 2, id: 3, edge: 4 };
    engine.run('voronoi', () => `${HEADER}${SAMPLING}${NOISE}${COORD}
uniform int uFunc; uniform float uJitter; uniform int uOctaves; uniform float uGain; uniform int uInvert;
out vec4 o;
void main() {
  vec2 p = coord();
  uint seed = uint(uSeed);
  float sum = 0.0, amp = 1.0, norm = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= uOctaves) break;
    vec4 c = cellular(p, uJitter, seed + uint(i) * 97u);
    float v;
    if (uFunc == 0) v = c.x; else if (uFunc == 1) v = c.y; else if (uFunc == 2) v = c.y - c.x;
    else if (uFunc == 3) v = c.z; else v = c.w;
    sum += v * amp; norm += amp; amp *= uGain; p = p * 2.0 + 11.0;
  }
  float v = sum / norm;
  if (uInvert == 1) v = 1.0 - v;
  o = vec4(v, 0.0, 0.0, 1.0);
}`, {
      ...baseUniforms(p, o.width, o.height), uFunc: funcs[String(p.func)] ?? 0, uJitter: Number(p.jitter),
      uOctaves: Number(p.octaves) | 0, uGain: Number(p.gain), uInvert: p.invert ? 1 : 0,
    }, out);
    return { height: finish(engine, out, !!p.autolevel) };
  },
};

export const GradientNode: NodeDef = {
  type: 'gradient',
  title: 'Gradient',
  category: 'Primitive',
  description: 'Linear or radial ramp. Useful as a mask or for sloping terrain.',
  inputs: [],
  outputs: [{ key: 'height', label: 'Out', kind: 'height' }],
  params: [
    { key: 'kind', label: 'Type', type: 'select', default: 'linear', options: [{ value: 'linear', label: 'Linear' }, { value: 'radial', label: 'Radial' }] },
    { key: 'angle', label: 'Angle', type: 'float', default: 0, min: 0, max: 360, step: 1 },
    { key: 'radius', label: 'Radius', type: 'float', default: 0.5, min: 0.05, max: 2, step: 0.01 },
    { key: 'centerX', label: 'Center X', type: 'float', default: 0.5, min: -1, max: 2, step: 0.01 },
    { key: 'centerY', label: 'Center Y', type: 'float', default: 0.5, min: -1, max: 2, step: 0.01 },
    { key: 'power', label: 'Curve', type: 'float', default: 1, min: 0.1, max: 5, step: 0.05 },
  ],
  evaluate(engine, _inputs, p, o) {
    const out = engine.alloc(o.width, o.height, 'R32F');
    engine.run('gradient', () => `${HEADER}
uniform int uKind; uniform float uAngle; uniform float uRadius; uniform vec2 uCenter; uniform float uPower; uniform float uAspect;
out vec4 o;
void main() {
  float v;
  if (uKind == 0) {
    vec2 d = vec2(cos(uAngle), sin(uAngle));
    vec2 c = vUv - 0.5;
    float ext = abs(d.x) * 0.5 + abs(d.y) * 0.5;
    v = dot(c, d) / (2.0 * ext) + 0.5;
  } else {
    vec2 c = (vUv - uCenter) * vec2(uAspect, 1.0);
    v = 1.0 - clamp(length(c) / (uRadius * max(uAspect, 1.0) * 0.5 + 1e-6), 0.0, 1.0);
  }
  o = vec4(pow(clamp(v, 0.0, 1.0), uPower), 0.0, 0.0, 1.0);
}`, {
      uKind: p.kind === 'radial' ? 1 : 0, uAngle: (Number(p.angle) * Math.PI) / 180, uRadius: Number(p.radius),
      uCenter: [Number(p.centerX), Number(p.centerY)], uPower: Number(p.power), uAspect: o.width / o.height,
    }, out);
    return { height: out };
  },
};

export const ShapeNode: NodeDef = {
  type: 'shape',
  title: 'Shape',
  category: 'Primitive',
  description: 'Island / plateau mask with soft, noise-distorted edges.',
  inputs: [],
  outputs: [{ key: 'height', label: 'Out', kind: 'height' }],
  params: [
    { key: 'kind', label: 'Type', type: 'select', default: 'circle', options: [{ value: 'circle', label: 'Circle' }, { value: 'square', label: 'Rounded square' }] },
    { key: 'size', label: 'Size', type: 'float', default: 0.65, min: 0.05, max: 1.5, step: 0.01 },
    { key: 'falloff', label: 'Falloff', type: 'float', default: 0.3, min: 0.01, max: 1, step: 0.01 },
    { key: 'distort', label: 'Edge distortion', type: 'float', default: 0.15, min: 0, max: 0.6, step: 0.01 },
    { key: 'seed', label: 'Seed', type: 'seed', default: 3, min: 0, max: 99999, step: 1 },
  ],
  evaluate(engine, _inputs, p, o) {
    const out = engine.alloc(o.width, o.height, 'R32F');
    engine.run('shape', () => `${HEADER}${SAMPLING}${NOISE}
uniform int uKind; uniform float uSize; uniform float uFalloff; uniform float uDistort; uniform int uSeed; uniform float uAspect;
out vec4 o;
void main() {
  vec2 c = (vUv - 0.5) * vec2(uAspect, 1.0);
  float d = uKind == 0 ? length(c) : max(abs(c.x), abs(c.y)) * 0.85 + length(c) * 0.15;
  d += uDistort * fbm(vUv * vec2(uAspect, 1.0) * 3.0, 4, 2.0, 0.5, uint(uSeed));
  float r = uSize * 0.5;
  float v = 1.0 - smoothstep(r - uFalloff * 0.5, r + uFalloff * 0.5, d);
  o = vec4(v, 0.0, 0.0, 1.0);
}`, {
      uKind: p.kind === 'square' ? 1 : 0, uSize: Number(p.size), uFalloff: Number(p.falloff), uDistort: Number(p.distort),
      uSeed: Number(p.seed) | 0, uAspect: o.width / o.height,
    }, out);
    return { height: out };
  },
};

export const ConstantNode: NodeDef = {
  type: 'constant',
  title: 'Constant',
  category: 'Primitive',
  description: 'Flat value.',
  inputs: [],
  outputs: [{ key: 'height', label: 'Out', kind: 'height' }],
  params: [{ key: 'value', label: 'Value', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01 }],
  evaluate(engine, _inputs, p, o) {
    const out = engine.alloc(o.width, o.height, 'R32F');
    engine.fill(out, [Number(p.value), 0, 0, 1]);
    return { height: out };
  },
};

export const PRIMITIVES: NodeDef[] = [MountainNode, PerlinNode, VoronoiNode, GradientNode, ShapeNode, ConstantNode];
