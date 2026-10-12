import { HEADER, SAMPLING, NOISE } from '../../shaders/common';
import type { NodeDef } from '../types';
import type { Tex } from '../../gl/texture';
import type { Engine } from '../engine';

const IN_OUT = { inputs: [{ key: 'height', label: 'In', kind: 'height' as const }], outputs: [{ key: 'height', label: 'Out', kind: 'height' as const }] };

function need(t: Tex | null | undefined, name: string): Tex {
  if (!t) throw new Error(`${name}: input not connected`);
  return t;
}

export const CombineNode: NodeDef = {
  type: 'combine',
  title: 'Combine',
  category: 'Modifier',
  description: 'Blend two heightfields with a mode and ratio; an optional mask limits where B applies.',
  inputs: [
    { key: 'a', label: 'A', kind: 'height' },
    { key: 'b', label: 'B', kind: 'height' },
    { key: 'mask', label: 'Mask', kind: 'height', optional: true },
  ],
  outputs: [{ key: 'height', label: 'Out', kind: 'height' }],
  params: [
    { key: 'mode', label: 'Mode', type: 'select', default: 'add', options: [
      { value: 'add', label: 'Add' }, { value: 'subtract', label: 'Subtract' }, { value: 'multiply', label: 'Multiply' },
      { value: 'max', label: 'Max' }, { value: 'min', label: 'Min' }, { value: 'blend', label: 'Blend (mix)' },
      { value: 'screen', label: 'Screen' }, { value: 'overlay', label: 'Overlay' }, { value: 'difference', label: 'Difference' }] },
    { key: 'ratio', label: 'Ratio', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01 },
    { key: 'clamp', label: 'Clamp 0..1', type: 'bool', default: true },
  ],
  evaluate(engine, inputs, p, o) {
    const a = need(inputs.a, 'Combine A');
    const b = inputs.b ?? a;
    const modes: Record<string, number> = { add: 0, subtract: 1, multiply: 2, max: 3, min: 4, blend: 5, screen: 6, overlay: 7, difference: 8 };
    const out = engine.alloc(o.width, o.height, 'R32F');
    engine.run('combine', () => `${HEADER}${SAMPLING}
uniform sampler2D uA; uniform sampler2D uB; uniform sampler2D uMask; uniform int uHasMask; uniform int uMode; uniform float uRatio; uniform int uClamp;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float a = texelFetch(uA, p, 0).r;
  float b = sampleBilinear(uB, vUv).r;
  float m = uHasMask == 1 ? sampleBilinear(uMask, vUv).r : 1.0;
  float r;
  if (uMode == 0) r = a + b * uRatio * 2.0;
  else if (uMode == 1) r = a - b * uRatio * 2.0;
  else if (uMode == 2) r = mix(a, a * b, uRatio);
  else if (uMode == 3) r = mix(a, max(a, b), uRatio);
  else if (uMode == 4) r = mix(a, min(a, b), uRatio);
  else if (uMode == 5) r = mix(a, b, uRatio);
  else if (uMode == 6) r = mix(a, 1.0 - (1.0 - a) * (1.0 - b), uRatio);
  else if (uMode == 7) r = mix(a, a < 0.5 ? 2.0 * a * b : 1.0 - 2.0 * (1.0 - a) * (1.0 - b), uRatio);
  else r = mix(a, abs(a - b), uRatio);
  r = mix(a, r, m);
  if (uClamp == 1) r = clamp(r, 0.0, 1.0);
  o = vec4(r, 0.0, 0.0, 1.0);
}`, { uA: a, uB: b, uMask: inputs.mask ?? a, uHasMask: inputs.mask ? 1 : 0, uMode: modes[String(p.mode)] ?? 0, uRatio: Number(p.ratio), uClamp: p.clamp ? 1 : 0 }, out);
    return { height: out };
  },
};

export const WarpNode: NodeDef = {
  type: 'warp',
  title: 'Warp',
  category: 'Modifier',
  description: 'Domain-warps the input with fractal noise, breaking up regular shapes.',
  inputs: [{ key: 'height', label: 'In', kind: 'height' }, { key: 'mask', label: 'Mask', kind: 'height', optional: true }],
  outputs: [{ key: 'height', label: 'Out', kind: 'height' }],
  params: [
    { key: 'strength', label: 'Strength', type: 'float', default: 0.05, min: 0, max: 0.5, step: 0.001, hint: 'Displacement as a fraction of map width' },
    { key: 'scale', label: 'Scale', type: 'float', default: 3, min: 0.25, max: 64, step: 0.25 },
    { key: 'octaves', label: 'Octaves', type: 'int', default: 4, min: 1, max: 10, step: 1 },
    { key: 'seed', label: 'Seed', type: 'seed', default: 7, min: 0, max: 99999, step: 1 },
  ],
  evaluate(engine, inputs, p, o) {
    const src = need(inputs.height, 'Warp');
    const out = engine.alloc(o.width, o.height, 'R32F');
    engine.run('warp', () => `${HEADER}${SAMPLING}${NOISE}
uniform sampler2D uSrc; uniform sampler2D uMask; uniform int uHasMask; uniform float uStrength; uniform float uScale; uniform int uOctaves; uniform int uSeed; uniform float uAspect;
out vec4 o;
void main() {
  vec2 q = vec2(vUv.x * uAspect, vUv.y) * uScale;
  vec2 w = warpVec(q, uOctaves, uint(uSeed)) * uStrength;
  float m = uHasMask == 1 ? texelFetch(uMask, ivec2(gl_FragCoord.xy), 0).r : 1.0;
  vec2 uv = vUv + w * m * vec2(1.0, uAspect);
  o = vec4(sampleBilinear(uSrc, clamp(uv, 0.0, 1.0)).r, 0.0, 0.0, 1.0);
}`, { uSrc: src, uMask: inputs.mask ?? src, uHasMask: inputs.mask ? 1 : 0, uStrength: Number(p.strength), uScale: Number(p.scale), uOctaves: Number(p.octaves) | 0, uSeed: Number(p.seed) | 0, uAspect: o.width / o.height }, out);
    return { height: out };
  },
};

export const TerraceNode: NodeDef = {
  type: 'terrace',
  title: 'Terrace',
  category: 'Modifier',
  description: 'Stratified steps with adjustable sharpness and non-uniform spacing.',
  inputs: [{ key: 'height', label: 'In', kind: 'height' }, { key: 'mask', label: 'Mask', kind: 'height', optional: true }],
  outputs: [{ key: 'height', label: 'Out', kind: 'height' }],
  params: [
    { key: 'steps', label: 'Steps', type: 'int', default: 12, min: 2, max: 64, step: 1 },
    { key: 'sharpness', label: 'Sharpness', type: 'float', default: 0.7, min: 0, max: 1, step: 0.01 },
    { key: 'uniformity', label: 'Uniformity', type: 'float', default: 0.7, min: 0, max: 1, step: 0.01, hint: 'Lower values vary the step heights' },
    { key: 'intensity', label: 'Intensity', type: 'float', default: 1, min: 0, max: 1, step: 0.01 },
    { key: 'seed', label: 'Seed', type: 'seed', default: 11, min: 0, max: 99999, step: 1 },
  ],
  evaluate(engine, inputs, p, o) {
    const src = need(inputs.height, 'Terrace');
    const out = engine.alloc(o.width, o.height, 'R32F');
    engine.run('terrace', () => `${HEADER}${SAMPLING}${NOISE}
uniform sampler2D uSrc; uniform sampler2D uMask; uniform int uHasMask; uniform int uSteps; uniform float uSharp; uniform float uUniform; uniform float uIntensity; uniform int uSeed;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float h = texelFetch(uSrc, p, 0).r;
  float m = uHasMask == 1 ? texelFetch(uMask, p, 0).r : 1.0;
  float n = float(uSteps);
  float t = h * n;
  float k = floor(t);
  // non-uniform step heights: jitter each step boundary by hashed noise
  float jit = (hash2f(ivec2(int(k), 0), uint(uSeed)) - 0.5) * (1.0 - uUniform);
  float f = fract(t);
  f = clamp(f + jit * 0.5, 0.0, 1.0);
  float s = mix(1.0, 24.0, uSharp);
  float g = pow(f, s);        // sharp lower part
  float g2 = 1.0 - pow(1.0 - f, s);
  float shaped = mix(f, mix(g, g2, step(0.5, f)), uSharp);
  float r = (k + shaped) / n;
  o = vec4(mix(h, r, uIntensity * m), 0.0, 0.0, 1.0);
}`, { uSrc: src, uMask: inputs.mask ?? src, uHasMask: inputs.mask ? 1 : 0, uSteps: Number(p.steps) | 0, uSharp: Number(p.sharpness), uUniform: Number(p.uniformity), uIntensity: Number(p.intensity), uSeed: Number(p.seed) | 0 }, out);
    return { height: out };
  },
};

/** Separable gaussian blur with pyramid downsampling for large radii. */
export function blur(engine: Engine, src: Tex, radiusFrac: number): Tex {
  let sigma = radiusFrac * src.width;
  if (sigma < 0.3) return engine.copy(src, 'R32F');
  let cur = engine.pool.retain(src);
  // Downsample while sigma is large (each halving divides sigma by 2).
  while (sigma > 6 && cur.width > 64) {
    const next = engine.resample(cur, Math.ceil(cur.width / 2), Math.ceil(cur.height / 2), 'R32F');
    engine.release(cur);
    cur = next;
    sigma /= 2;
  }
  const radius = Math.min(Math.ceil(sigma * 3), 24);
  const pass = (input: Tex, dir: [number, number]): Tex => {
    const out = engine.alloc(input.width, input.height, 'R32F');
    engine.run('gauss', () => `${HEADER}${SAMPLING}
uniform sampler2D uSrc; uniform vec2 uDir; uniform float uSigma; uniform int uRadius;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float sum = 0.0, wsum = 0.0;
  for (int i = -24; i <= 24; i++) {
    if (abs(i) > uRadius) continue;
    float w = exp(-0.5 * float(i * i) / (uSigma * uSigma));
    sum += w * fetchC(uSrc, p + ivec2(uDir) * i).r;
    wsum += w;
  }
  o = vec4(sum / wsum, 0.0, 0.0, 1.0);
}`, { uSrc: input, uDir: dir, uSigma: sigma, uRadius: radius }, out);
    return out;
  };
  const h = pass(cur, [1, 0]);
  const v = pass(h, [0, 1]);
  engine.release(h);
  engine.release(cur);
  if (v.width !== src.width || v.height !== src.height) {
    const up = engine.resample(v, src.width, src.height, 'R32F');
    engine.release(v);
    return up;
  }
  return v;
}

export const BlurNode: NodeDef = {
  type: 'blur',
  title: 'Blur',
  category: 'Modifier',
  description: 'Gaussian blur, resolution independent (radius relative to map width).',
  ...IN_OUT,
  params: [{ key: 'radius', label: 'Radius', type: 'float', default: 0.005, min: 0, max: 0.1, step: 0.0005 }],
  evaluate(engine, inputs) {
    return { height: blur(engine, need(inputs.height, 'Blur'), 0) };
  },
};
BlurNode.evaluate = (engine, inputs, p) => ({ height: blur(engine, need(inputs.height, 'Blur'), Number(p.radius)) });

export const LevelsNode: NodeDef = {
  type: 'levels',
  title: 'Levels',
  category: 'Modifier',
  description: 'Remap input range to output range with a gamma curve (like Photoshop levels).',
  ...IN_OUT,
  params: [
    { key: 'inLow', label: 'In low', type: 'float', default: 0, min: 0, max: 1, step: 0.005 },
    { key: 'inHigh', label: 'In high', type: 'float', default: 1, min: 0, max: 1, step: 0.005 },
    { key: 'gamma', label: 'Gamma', type: 'float', default: 1, min: 0.1, max: 5, step: 0.01 },
    { key: 'outLow', label: 'Out low', type: 'float', default: 0, min: 0, max: 1, step: 0.005 },
    { key: 'outHigh', label: 'Out high', type: 'float', default: 1, min: 0, max: 1, step: 0.005 },
  ],
  evaluate(engine, inputs, p, o) {
    const src = need(inputs.height, 'Levels');
    const out = engine.alloc(o.width, o.height, 'R32F');
    engine.run('levels', () => `${HEADER}
uniform sampler2D uSrc; uniform vec4 uIn; uniform float uGamma; uniform vec2 uOut;
out vec4 o;
void main() {
  float h = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0).r;
  float t = clamp((h - uIn.x) / max(uIn.y - uIn.x, 1e-6), 0.0, 1.0);
  t = pow(t, 1.0 / uGamma);
  o = vec4(mix(uOut.x, uOut.y, t), 0.0, 0.0, 1.0);
}`, { uSrc: src, uIn: [Number(p.inLow), Number(p.inHigh), 0, 0], uGamma: Number(p.gamma), uOut: [Number(p.outLow), Number(p.outHigh)] }, out);
    return { height: out };
  },
};

export const AutolevelNode: NodeDef = {
  type: 'autolevel',
  title: 'Autolevel',
  category: 'Modifier',
  description: 'Stretches the input so its minimum is 0 and maximum is 1.',
  ...IN_OUT,
  params: [],
  evaluate(engine, inputs) {
    return { height: engine.normalize(need(inputs.height, 'Autolevel')) };
  },
};

export const ClampNode: NodeDef = {
  type: 'clamp',
  title: 'Clamp',
  category: 'Modifier',
  description: 'Clamp values to a range (flattens peaks / fills basins).',
  ...IN_OUT,
  params: [
    { key: 'min', label: 'Min', type: 'float', default: 0, min: 0, max: 1, step: 0.005 },
    { key: 'max', label: 'Max', type: 'float', default: 1, min: 0, max: 1, step: 0.005 },
  ],
  evaluate(engine, inputs, p, o) {
    const src = need(inputs.height, 'Clamp');
    const out = engine.alloc(o.width, o.height, 'R32F');
    engine.run('clampn', () => `${HEADER}
uniform sampler2D uSrc; uniform vec2 uRange; out vec4 o;
void main() { o = vec4(clamp(texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0).r, uRange.x, uRange.y), 0.0, 0.0, 1.0); }`, { uSrc: src, uRange: [Number(p.min), Number(p.max)] }, out);
    return { height: out };
  },
};

export const AdjustNode: NodeDef = {
  type: 'adjust',
  title: 'Adjust',
  category: 'Modifier',
  description: 'Multiply and offset heights; optionally invert.',
  ...IN_OUT,
  params: [
    { key: 'multiply', label: 'Multiply', type: 'float', default: 1, min: -4, max: 4, step: 0.01 },
    { key: 'add', label: 'Add', type: 'float', default: 0, min: -1, max: 1, step: 0.005 },
    { key: 'invert', label: 'Invert', type: 'bool', default: false },
    { key: 'clamp', label: 'Clamp 0..1', type: 'bool', default: true },
  ],
  evaluate(engine, inputs, p, o) {
    const src = need(inputs.height, 'Adjust');
    const out = engine.alloc(o.width, o.height, 'R32F');
    engine.run('adjust', () => `${HEADER}
uniform sampler2D uSrc; uniform float uMul; uniform float uAdd; uniform int uInvert; uniform int uClamp; out vec4 o;
void main() {
  float h = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0).r;
  if (uInvert == 1) h = 1.0 - h;
  h = h * uMul + uAdd;
  if (uClamp == 1) h = clamp(h, 0.0, 1.0);
  o = vec4(h, 0.0, 0.0, 1.0);
}`, { uSrc: src, uMul: Number(p.multiply), uAdd: Number(p.add), uInvert: p.invert ? 1 : 0, uClamp: p.clamp ? 1 : 0 }, out);
    return { height: out };
  },
};

export const InvertNode: NodeDef = {
  type: 'invert',
  title: 'Invert',
  category: 'Modifier',
  description: '1 - input.',
  ...IN_OUT,
  params: [],
  evaluate(engine, inputs, _p, o) {
    const src = need(inputs.height, 'Invert');
    const out = engine.alloc(o.width, o.height, 'R32F');
    engine.run('invert', () => `${HEADER}
uniform sampler2D uSrc; out vec4 o;
void main() { o = vec4(1.0 - texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0).r, 0.0, 0.0, 1.0); }`, { uSrc: src }, out);
    return { height: out };
  },
};

export const MODIFIERS: NodeDef[] = [CombineNode, WarpNode, TerraceNode, BlurNode, LevelsNode, AutolevelNode, ClampNode, AdjustNode, InvertNode];
