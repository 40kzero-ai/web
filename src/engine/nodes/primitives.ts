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
  description: 'Eroded-looking ridged mountains: slopes damp fine detail so ridgelines stay crisp and flanks stay planar. Stretch and angle align the range.',
  inputs: [],
  outputs: [{ key: 'height', label: 'Out', kind: 'height' }],
  params: [
    ...COMMON_PARAMS(2),
    { key: 'octaves', label: 'Octaves', type: 'int', default: 8, min: 1, max: 16, step: 1, hint: 'Fewer octaves = no pimple-like micro bumps; let erosion add detail' },
    { key: 'gain', label: 'Persistence', type: 'float', default: 0.47, min: 0.2, max: 0.9, step: 0.01 },
    { key: 'sharpness', label: 'Ridge sharpness', type: 'float', default: 1.3, min: 0.5, max: 4, step: 0.05 },
    { key: 'erosion', label: 'Slope erosion', type: 'float', default: 0.7, min: 0, max: 1, step: 0.01, hint: 'Damps detail on steep flanks (crisp ridges, smooth slopes)' },
    { key: 'stretch', label: 'Range stretch', type: 'float', default: 1.8, min: 1, max: 5, step: 0.05, hint: 'Elongates ridges into a range' },
    { key: 'angle', label: 'Range angle', type: 'float', default: 30, min: 0, max: 180, step: 1 },
    { key: 'angleVar', label: 'Angle variation', type: 'float', default: 60, min: 0, max: 180, step: 1, hint: 'Ranges turn across the map instead of one global grain' },
    { key: 'bulk', label: 'Bulk', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, hint: 'Large scale mass variation' },
    { key: 'warp', label: 'Warp', type: 'float', default: 0.25, min: 0, max: 2, step: 0.01 },
    { key: 'peaks', label: 'Peak emphasis', type: 'float', default: 1.25, min: 0.5, max: 3, step: 0.05, hint: 'Power curve applied to the result' },
    { key: 'autolevel', label: 'Autolevel', type: 'bool', default: true },
  ],
  evaluate(engine, _inputs, p, o) {
    const out = engine.alloc(o.width, o.height, 'R32F');
    engine.run('mountain2', () => `${HEADER}${SAMPLING}${NOISE}${COORD}
uniform int uOctaves; uniform float uGain; uniform float uSharp; uniform float uErosion; uniform float uStretch; uniform float uAngle; uniform float uAngleVar;
uniform float uBulk; uniform float uWarp; uniform float uPeaks;
out vec4 o;
void main() {
  vec2 p = coord();
  uint seed = uint(uSeed);
  // locally varying range direction: a slow noise field turns the anisotropy across the map
  float ang = uAngle + uAngleVar * fbm(p * 0.35 + 7.1, 3, 2.0, 0.5, seed + 4242u);
  float ca = cos(ang), sa = sin(ang);
  vec2 q0 = vec2(ca * p.x - sa * p.y, sa * p.x + ca * p.y);
  q0.x /= uStretch;
  // large-scale bends so ranges curve rather than run straight
  q0 += 0.35 * warpVec(p * 0.25 + 3.3, 2, seed + 999u);
  p = q0;
  if (uWarp > 0.0) p += uWarp * warpVec(p * 0.6, 3, seed + 777u);
  float sum = 0.0, amp = 1.0, norm = 0.0, f = 1.0;
  vec2 dsum = vec2(0.0);
  for (int i = 0; i < 16; i++) {
    if (i >= uOctaves) break;
    vec3 nd = perlinD(p * f + vec2(float(i) * 5.2, float(i) * 1.3), seed + uint(i) * 131u);
    float r = 1.0 - abs(nd.x);
    float rk = pow(max(r, 1e-4), uSharp);
    // Accumulate the raw noise gradient (continuous and largest right on ridgelines, where the
    // ridged value folds) so flanks AND crests damp finer octaves; using the ridged derivative
    // instead leaves an undamped seam along every ridge.
    dsum += nd.yz * f * amp;
    float w = 1.0 / (1.0 + uErosion * 1.5 * dot(dsum, dsum));
    sum += amp * rk * w;
    norm += amp;
    amp *= uGain;
    f *= 2.03;
  }
  float ridged = sum / norm;
  float bulk = fbm(p * 0.45 + 3.7, 4, 2.0, 0.5, seed + 55u) * 0.5 + 0.5;
  float h = ridged * mix(1.0, bulk * 1.3, uBulk);
  o = vec4(pow(max(h, 0.0), uPeaks), 0.0, 0.0, 1.0);
}`, {
      ...baseUniforms(p, o.width, o.height),
      uOctaves: Number(p.octaves) | 0, uGain: Number(p.gain), uSharp: Number(p.sharpness), uErosion: Number(p.erosion),
      uStretch: Number(p.stretch), uAngle: (Number(p.angle) * Math.PI) / 180, uAngleVar: (Number(p.angleVar ?? 0) * Math.PI) / 180,
      uBulk: Number(p.bulk), uWarp: Number(p.warp), uPeaks: Number(p.peaks),
    }, out);
    return { height: finish(engine, out, !!p.autolevel) };
  },
};

export const HillsNode: NodeDef = {
  type: 'hills',
  title: 'Hills',
  category: 'Primitive',
  description: 'Rolling hills and lowlands: smooth, slope-damped noise. Use low Relief for plains.',
  inputs: [],
  outputs: [{ key: 'height', label: 'Out', kind: 'height' }],
  params: [
    ...COMMON_PARAMS(3),
    { key: 'octaves', label: 'Octaves', type: 'int', default: 7, min: 1, max: 12, step: 1 },
    { key: 'gain', label: 'Persistence', type: 'float', default: 0.42, min: 0.2, max: 0.8, step: 0.01 },
    { key: 'roundness', label: 'Roundness', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, hint: 'Softens crests' },
    { key: 'relief', label: 'Relief', type: 'float', default: 0.35, min: 0.02, max: 1, step: 0.01, hint: 'Output amplitude' },
    { key: 'base', label: 'Base height', type: 'float', default: 0.08, min: 0, max: 1, step: 0.01 },
  ],
  evaluate(engine, _inputs, p, o) {
    const raw = engine.alloc(o.width, o.height, 'R32F');
    engine.run('hills', () => `${HEADER}${SAMPLING}${NOISE}${COORD}
uniform int uOctaves; uniform float uGain; uniform float uRound;
out vec4 o;
void main() {
  vec2 p = coord();
  uint seed = uint(uSeed);
  float sum = 0.0, amp = 1.0, norm = 0.0, f = 1.0;
  vec2 dsum = vec2(0.0);
  for (int i = 0; i < 12; i++) {
    if (i >= uOctaves) break;
    vec3 nd = perlinD(p * f + vec2(float(i) * 3.1, float(i) * 7.7), seed + uint(i) * 131u);
    float v = nd.x;
    dsum += nd.yz * f * amp;
    float w = 1.0 / (1.0 + 2.0 * dot(dsum, dsum));
    sum += amp * v * w;
    norm += amp;
    amp *= uGain;
    f *= 2.0;
  }
  float h = sum / norm * 0.5 + 0.5;
  // roundness: ease towards smooth crests
  h = mix(h, smoothstep(0.0, 1.0, h), uRound);
  o = vec4(h, 0.0, 0.0, 1.0);
}`, { ...baseUniforms(p, o.width, o.height), uOctaves: Number(p.octaves) | 0, uGain: Number(p.gain), uRound: Number(p.roundness) }, raw);
    const norm = engine.normalize(raw);
    engine.release(raw);
    const out = engine.alloc(o.width, o.height, 'R32F');
    engine.run('hills_scale', () => `${HEADER}
uniform sampler2D uSrc; uniform float uRelief; uniform float uBase; out vec4 o;
void main() { o = vec4(clamp(uBase + texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0).r * uRelief, 0.0, 1.0), 0.0, 0.0, 1.0); }`,
      { uSrc: norm, uRelief: Number(p.relief), uBase: Number(p.base) }, out);
    engine.release(norm);
    return { height: out };
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


export const VolcanoNode: NodeDef = {
  type: 'volcano',
  title: 'Volcano',
  category: 'Primitive',
  description: 'Stratovolcano: concave cone with a crater, irregular outline and radial ridges and gullies. Combine with Hills / Shape for an island, then erode.',
  inputs: [],
  outputs: [{ key: 'height', label: 'Out', kind: 'height' }],
  params: [
    { key: 'seed', label: 'Seed', type: 'seed', default: 2, min: 0, max: 99999, step: 1 },
    { key: 'centerX', label: 'Center X', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01 },
    { key: 'centerY', label: 'Center Y', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01 },
    { key: 'radius', label: 'Base radius', type: 'float', default: 0.32, min: 0.05, max: 0.8, step: 0.01, hint: 'Fraction of map height' },
    { key: 'concavity', label: 'Flank concavity', type: 'float', default: 2.2, min: 1, max: 4, step: 0.05, hint: 'Steep summit, gentle foot' },
    { key: 'crater', label: 'Crater radius', type: 'float', default: 0.08, min: 0, max: 0.5, step: 0.005, hint: 'Relative to base radius' },
    { key: 'craterDepth', label: 'Crater depth', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01 },
    { key: 'irregular', label: 'Outline irregularity', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01 },
    { key: 'ridges', label: 'Radial ridges', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01 },
    { key: 'ridgeCount', label: 'Ridge count', type: 'float', default: 14, min: 4, max: 40, step: 1 },
    { key: 'secondary', label: 'Parasitic cones', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01 },
  ],
  evaluate(engine, _inputs, p, o) {
    const out = engine.alloc(o.width, o.height, 'R32F');
    engine.run('volcano', () => `${HEADER}${SAMPLING}${NOISE}
uniform int uSeed; uniform vec2 uCenter; uniform float uRadius; uniform float uConc; uniform float uCrater; uniform float uCraterDepth;
uniform float uIrregular; uniform float uRidges; uniform float uRidgeCount; uniform float uSecondary; uniform float uAspect;
out vec4 o;
float cone(vec2 c, float R, float conc, float irr, uint seed, float craterR, float craterD, float ridges, float rc) {
  float r = length(c);
  float th = atan(c.y, c.x);
  // irregular outline: radius varies with angle (low frequency) and with distance (lobes)
  float wob = fbm(vec2(cos(th), sin(th)) * 2.2 + 11.0, 4, 2.0, 0.5, seed) * irr * 0.5;
  float Rl = R * (1.0 + wob + 0.25 * irr * fbm(c * 3.0 / R, 3, 2.0, 0.5, seed + 3u));
  float t = clamp(r / Rl, 0.0, 1.0);
  float h = pow(1.0 - t, conc);
  // radial ridges/gullies: ridged noise in polar coordinates, stronger on the flanks
  float pr = 1.0 - abs(perlin(vec2(th * rc * 0.159155, r / R * 5.0), seed + 9u));
  float pr2 = 1.0 - abs(perlin(vec2(th * rc * 0.318, r / R * 11.0), seed + 19u));
  float flank = smoothstep(0.0, 0.25, t) * (1.0 - smoothstep(0.75, 1.0, t));
  h += ridges * 0.12 * (pr - 0.5) * flank * h + ridges * 0.05 * (pr2 - 0.5) * flank;
  // crater
  float cr = craterR * R;
  if (cr > 0.0) {
    float u = clamp(r / cr, 0.0, 1.0);
    float bowl = (1.0 - u * u);
    h -= craterD * 0.35 * bowl * smoothstep(1.0, 0.85, u) ;
  }
  return max(h, 0.0);
}
void main() {
  vec2 c = (vUv - uCenter) * vec2(uAspect, 1.0);
  uint seed = uint(uSeed);
  float h = cone(c, uRadius, uConc, uIrregular, seed, uCrater, uCraterDepth, uRidges, uRidgeCount);
  // parasitic cones on the lower flank
  for (int i = 0; i < 3; i++) {
    if (uSecondary <= 0.0) break;
    vec2 hv = hash2v(ivec2(i + 1, 0), seed + 77u);
    float a = hv.x * 6.2831853;
    float d = uRadius * (0.45 + 0.4 * hv.y);
    vec2 cc = c - vec2(cos(a), sin(a)) * d;
    float sc = uRadius * (0.12 + 0.1 * hv.x) ;
    float sh = cone(cc, sc, 1.6, uIrregular * 0.5, seed + uint(i) * 31u, 0.35, 0.6, uRidges * 0.5, 8.0) * uSecondary * 0.35;
    h = max(h, sh + h * 0.6);
  }
  o = vec4(h, 0.0, 0.0, 1.0);
}`, {
      uSeed: Number(p.seed) | 0, uCenter: [Number(p.centerX), Number(p.centerY)], uRadius: Number(p.radius), uConc: Number(p.concavity),
      uCrater: Number(p.crater), uCraterDepth: Number(p.craterDepth), uIrregular: Number(p.irregular), uRidges: Number(p.ridges), uRidgeCount: Number(p.ridgeCount),
      uSecondary: Number(p.secondary), uAspect: o.width / o.height,
    }, out);
    return { height: out };
  },
};


export const RangeNode: NodeDef = {
  type: 'range',
  title: 'Range',
  category: 'Primitive',
  description: 'A single mountain range: a broad belt along a wandering divide, filled with peak massifs and sub-ridges, with spurs running off the divide and concave flanks to the foot. Follow with Fluvial and Erosion.',
  inputs: [],
  outputs: [{ key: 'height', label: 'Out', kind: 'height' }, { key: 'mask', label: 'Range mask', kind: 'height', isMask: true }],
  params: [
    { key: 'seed', label: 'Seed', type: 'seed', default: 5, min: 0, max: 99999, step: 1 },
    { key: 'angle', label: 'Direction', type: 'float', default: 20, min: 0, max: 180, step: 1 },
    { key: 'length', label: 'Length', type: 'float', default: 1.0, min: 0.2, max: 1.5, step: 0.01, hint: 'Fraction of map width' },
    { key: 'width', label: 'Half width', type: 'float', default: 0.42, min: 0.05, max: 0.8, step: 0.01, hint: 'Fraction of map height' },
    { key: 'bend', label: 'Crest wander', type: 'float', default: 0.8, min: 0, max: 1.5, step: 0.01 },
    { key: 'concavity', label: 'Flank concavity', type: 'float', default: 1.5, min: 0.8, max: 4, step: 0.05, hint: 'Steep near the crest, gentle at the foot' },
    { key: 'massif', label: 'Massifs', type: 'float', default: 0.8, min: 0, max: 1, step: 0.01, hint: 'Large peak groups along the divide' },
    { key: 'massifScale', label: 'Massif size', type: 'float', default: 2.4, min: 1, max: 6, step: 0.1 },
    { key: 'spur', label: 'Spur ridges', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01 },
    { key: 'spurScale', label: 'Spur density', type: 'float', default: 4, min: 1, max: 16, step: 0.5 },
    { key: 'detail', label: 'Rock detail', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01 },
    { key: 'foot', label: 'Foothills', type: 'float', default: 0.2, min: 0, max: 0.6, step: 0.01, hint: 'Relief of the land around the range' },
  ],
  evaluate(engine, _inputs, p, o) {
    const raw = engine.alloc(o.width, o.height, 'R32F');
    const mask = engine.alloc(o.width, o.height, 'R32F');
    engine.run('range2', () => `${HEADER}${SAMPLING}${NOISE}
uniform int uSeed; uniform float uAngle; uniform float uLength; uniform float uWidth; uniform float uBend; uniform float uConc;
uniform float uMassif; uniform float uMassifScale; uniform float uSpur; uniform float uSpurScale; uniform float uDetail; uniform float uFoot; uniform float uAspect;
layout(location = 0) out vec4 oH; layout(location = 1) out vec4 oM;
float ridgedFbm(vec2 p, int oct, uint seed, float gain) {
  float sum = 0.0, amp = 1.0, norm = 0.0, w = 1.0;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    float n = 1.0 - abs(perlin(p, seed + uint(i) * 131u));
    n = n * n * w;
    w = clamp(n * 1.6, 0.0, 1.0);
    sum += n * amp; norm += amp; amp *= gain; p = p * 2.05 + 7.3;
  }
  return sum / norm;
}
void main() {
  uint seed = uint(uSeed);
  vec2 c = (vUv - 0.5) * vec2(uAspect, 1.0);
  float ca = cos(uAngle), sa = sin(uAngle);
  vec2 q = vec2(ca * c.x + sa * c.y, -sa * c.x + ca * c.y);   // divide runs along q.x
  float halfLen = uLength * uAspect * 0.5;
  float t = q.x / max(halfLen, 1e-4);
  // wandering divide with secondary wiggles
  float yc = uBend * (0.3 * fbm(vec2(q.x * 1.1 + 3.1, 0.7), 2, 2.0, 0.5, seed) + 0.08 * fbm(vec2(q.x * 4.0 + 1.0, 2.2), 2, 2.0, 0.5, seed + 3u));
  float d = abs(q.y - yc);
  float taper = 1.0 - smoothstep(0.6, 1.1, abs(t));
  // belt envelope with an irregular foot line
  float w = uWidth * (1.0 + 0.4 * fbm(vec2(q.x * 1.6, q.y * 1.6) + 9.0, 3, 2.0, 0.5, seed + 9u));
  float f = pow(max(1.0 - d / w, 0.0), uConc) * taper;
  // peak massifs: large ridged noise, slightly stretched along the divide, sharpened
  vec2 mq = vec2(q.x * 0.8, q.y * 1.1) * uMassifScale;
  mq += 0.3 * warpVec(mq * 0.7 + 5.0, 2, seed + 17u);
  float m = ridgedFbm(mq, 3, seed + 11u, 0.55);
  m = pow(m, 1.4);
  // spurs: ridged noise stretched perpendicular to the divide
  vec2 sp = vec2(q.x * uSpurScale, q.y * uSpurScale * 0.3);
  sp += 0.3 * warpVec(sp * 0.5, 2, seed + 21u);
  float spur = ridgedFbm(sp, 4, seed + 31u, 0.5);
  // rock detail
  float det = ridgedFbm(c * 12.0 + 2.0, 5, seed + 41u, 0.5);
  float body = mix(1.0, 0.15 + 0.85 * m, uMassif) * mix(1.0, 0.5 + 0.5 * spur, uSpur);
  float h = f * body;
  h += uDetail * 0.1 * (det - 0.5) * f;
  // surrounding land: rugged foothills that merge into the range
  float foot = uFoot * (fbm(c * 2.5 + 17.0, 6, 2.0, 0.5, seed + 51u) * 0.5 + 0.5);
  h = max(h, 0.0) + foot * (1.0 - 0.6 * f);
  oH = vec4(h, 0.0, 0.0, 1.0);
  oM = vec4(clamp(f * 1.5, 0.0, 1.0), 0.0, 0.0, 1.0);
}`, {
      uSeed: Number(p.seed) | 0, uAngle: (Number(p.angle) * Math.PI) / 180, uLength: Number(p.length), uWidth: Number(p.width), uBend: Number(p.bend),
      uConc: Number(p.concavity), uMassif: Number(p.massif), uMassifScale: Number(p.massifScale), uSpur: Number(p.spur), uSpurScale: Number(p.spurScale),
      uDetail: Number(p.detail), uFoot: Number(p.foot), uAspect: o.width / o.height,
    }, [raw, mask]);
    const height = engine.normalize(raw);
    engine.release(raw);
    return { height, mask };
  },
};

export const PRIMITIVES: NodeDef[] = [RangeNode, MountainNode, HillsNode, VolcanoNode, PerlinNode, VoronoiNode, GradientNode, ShapeNode, ConstantNode];
