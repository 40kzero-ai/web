import { HEADER, SAMPLING, TERRAIN, NOISE } from '../../shaders/common';
import type { NodeDef } from '../types';

export interface GradientStop { t: number; color: [number, number, number]; }

export const SATMAP_PRESETS: Record<string, { label: string; stops: GradientStop[] }> = {
  alpine: { label: 'Alpine', stops: [
    { t: 0.0, color: [0.16, 0.25, 0.12] }, { t: 0.18, color: [0.26, 0.38, 0.17] }, { t: 0.35, color: [0.42, 0.44, 0.26] },
    { t: 0.5, color: [0.45, 0.40, 0.33] }, { t: 0.68, color: [0.52, 0.50, 0.47] }, { t: 0.82, color: [0.78, 0.78, 0.76] }, { t: 1.0, color: [0.98, 0.98, 1.0] }] },
  desert: { label: 'Desert', stops: [
    { t: 0.0, color: [0.55, 0.42, 0.28] }, { t: 0.3, color: [0.72, 0.56, 0.36] }, { t: 0.55, color: [0.80, 0.64, 0.42] },
    { t: 0.75, color: [0.62, 0.45, 0.33] }, { t: 1.0, color: [0.46, 0.33, 0.27] }] },
  canyon: { label: 'Canyon', stops: [
    { t: 0.0, color: [0.35, 0.22, 0.16] }, { t: 0.25, color: [0.62, 0.33, 0.20] }, { t: 0.45, color: [0.80, 0.52, 0.30] },
    { t: 0.6, color: [0.70, 0.40, 0.26] }, { t: 0.8, color: [0.86, 0.68, 0.46] }, { t: 1.0, color: [0.65, 0.58, 0.50] }] },
  volcanic: { label: 'Volcanic', stops: [
    { t: 0.0, color: [0.08, 0.08, 0.09] }, { t: 0.3, color: [0.18, 0.16, 0.16] }, { t: 0.6, color: [0.32, 0.28, 0.26] },
    { t: 0.85, color: [0.50, 0.42, 0.38] }, { t: 1.0, color: [0.72, 0.65, 0.60] }] },
  tundra: { label: 'Tundra', stops: [
    { t: 0.0, color: [0.30, 0.36, 0.30] }, { t: 0.3, color: [0.46, 0.50, 0.38] }, { t: 0.55, color: [0.58, 0.58, 0.52] },
    { t: 0.75, color: [0.80, 0.80, 0.80] }, { t: 1.0, color: [1.0, 1.0, 1.0] }] },
  grayscale: { label: 'Grayscale', stops: [{ t: 0.0, color: [0, 0, 0] }, { t: 1.0, color: [1, 1, 1] }] },
  hypsometric: { label: 'Hypsometric', stops: [
    { t: 0.0, color: [0.1, 0.3, 0.6] }, { t: 0.2, color: [0.2, 0.6, 0.3] }, { t: 0.4, color: [0.8, 0.8, 0.3] },
    { t: 0.6, color: [0.8, 0.5, 0.2] }, { t: 0.8, color: [0.6, 0.3, 0.2] }, { t: 1.0, color: [1.0, 1.0, 1.0] }] },
};

function stopsToArray(stops: GradientStop[]): Float32Array {
  const arr = new Float32Array(8 * 4);
  for (let i = 0; i < 8; i++) {
    const s = stops[Math.min(i, stops.length - 1)];
    arr[i * 4] = s.color[0]; arr[i * 4 + 1] = s.color[1]; arr[i * 4 + 2] = s.color[2]; arr[i * 4 + 3] = s.t;
  }
  return arr;
}

export const SatMapNode: NodeDef = {
  type: 'satmap',
  title: 'SatMap',
  category: 'Color',
  description: 'Colorizes the terrain by altitude using a satellite-style gradient, with slope rock, flow wetness and snow.',
  inputs: [
    { key: 'height', label: 'In', kind: 'height' },
    { key: 'flow', label: 'Flow', kind: 'height', optional: true },
    { key: 'mask', label: 'Mask', kind: 'height', optional: true },
  ],
  outputs: [{ key: 'color', label: 'Color', kind: 'color' }, { key: 'height', label: 'Height', kind: 'height' }],
  params: [
    { key: 'preset', label: 'Library', type: 'select', default: 'alpine', options: Object.entries(SATMAP_PRESETS).map(([k, v]) => ({ value: k, label: v.label })) },
    { key: 'rockAngle', label: 'Rock angle', type: 'float', default: 40, min: 10, max: 90, step: 1, hint: 'Slopes steeper than this show rock' },
    { key: 'rockStrength', label: 'Rock strength', type: 'float', default: 0.7, min: 0, max: 1, step: 0.01 },
    { key: 'snowLine', label: 'Snow line', type: 'float', default: 0.78, min: 0, max: 1.5, step: 0.01, hint: 'Above 1 disables snow' },
    { key: 'flowTint', label: 'Flow wetness', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01 },
    { key: 'variation', label: 'Variation', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, hint: 'Noise-based color variation' },
    { key: 'seed', label: 'Seed', type: 'seed', default: 5, min: 0, max: 99999, step: 1 },
  ],
  evaluate(engine, inputs, p, o) {
    const h = inputs.height;
    if (!h) throw new Error('SatMap: input not connected');
    const preset = SATMAP_PRESETS[String(p.preset)] ?? SATMAP_PRESETS.alpine;
    const out = engine.alloc(o.width, o.height, 'RGBA8');
    engine.run('satmap', () => `${HEADER}${SAMPLING}${TERRAIN}${NOISE}
uniform sampler2D uH; uniform sampler2D uFlow; uniform sampler2D uMask; uniform int uHasFlow; uniform int uHasMask;
uniform vec4 uStops[8]; uniform int uNumStops; uniform float uHs;
uniform float uRockAngle; uniform float uRockStrength; uniform float uSnowLine; uniform float uFlowTint; uniform float uVariation; uniform int uSeed; uniform float uAspect;
out vec4 o;
vec3 gradient(float t) {
  vec3 c = uStops[0].rgb;
  for (int i = 1; i < 8; i++) {
    if (i >= uNumStops) break;
    float a = uStops[i - 1].a, b = uStops[i].a;
    float f = clamp((t - a) / max(b - a, 1e-5), 0.0, 1.0);
    c = mix(c, uStops[i].rgb, f);
  }
  return c;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float h = texelFetch(uH, p, 0).r;
  vec2 g = heightGradient(uH, p, uHs);
  float ang = degrees(atan(length(g)));
  vec2 q = vec2(vUv.x * uAspect, vUv.y);
  float var = fbm(q * 12.0, 4, 2.0, 0.5, uint(uSeed)) * 0.5;
  float ht = clamp(h + var * uVariation * 0.25, 0.0, 1.0);
  vec3 col = gradient(ht);
  col *= 1.0 + var * uVariation * 0.5;
  // rock on steep slopes
  float rock = smoothstep(uRockAngle - 10.0, uRockAngle + 10.0, ang) * uRockStrength;
  vec3 rockCol = mix(vec3(0.36, 0.33, 0.30), vec3(0.55, 0.52, 0.48), fbm(q * 40.0, 3, 2.0, 0.5, uint(uSeed) + 9u) * 0.5 + 0.5);
  col = mix(col, rockCol, rock);
  // snow above snow line, less on steep slopes
  float snow = smoothstep(uSnowLine - 0.08, uSnowLine + 0.05, h + var * 0.05) * (1.0 - smoothstep(35.0, 65.0, ang));
  col = mix(col, vec3(0.96, 0.97, 1.0), snow);
  if (uHasFlow == 1) {
    float f = sampleBilinear(uFlow, vUv).r;
    col = mix(col, col * vec3(0.55, 0.6, 0.62), clamp(f * 1.5, 0.0, 1.0) * uFlowTint);
  }
  if (uHasMask == 1) col *= mix(0.3, 1.0, sampleBilinear(uMask, vUv).r);
  o = vec4(pow(clamp(col, 0.0, 1.0), vec3(1.0 / 1.1)), 1.0);
}`, {
      uH: h, uFlow: inputs.flow ?? h, uMask: inputs.mask ?? h, uHasFlow: inputs.flow ? 1 : 0, uHasMask: inputs.mask ? 1 : 0,
      uStops: stopsToArray(preset.stops), uNumStops: preset.stops.length, uHs: o.heightRatio * o.width,
      uRockAngle: Number(p.rockAngle), uRockStrength: Number(p.rockStrength), uSnowLine: Number(p.snowLine), uFlowTint: Number(p.flowTint),
      uVariation: Number(p.variation), uSeed: Number(p.seed) | 0, uAspect: o.width / o.height,
    }, out);
    return { color: out, height: engine.pool.retain(h) };
  },
};

export const MixerNode: NodeDef = {
  type: 'mixer',
  title: 'Mixer',
  category: 'Color',
  description: 'Blend two color maps by a mask (e.g. sediment in valleys, rock on ridges).',
  inputs: [
    { key: 'a', label: 'A', kind: 'color' },
    { key: 'b', label: 'B', kind: 'color' },
    { key: 'mask', label: 'Mask', kind: 'height' },
    { key: 'height', label: 'Height', kind: 'height', optional: true },
  ],
  outputs: [{ key: 'color', label: 'Color', kind: 'color' }, { key: 'height', label: 'Height', kind: 'height' }],
  params: [
    { key: 'ratio', label: 'Ratio', type: 'float', default: 1, min: 0, max: 1, step: 0.01 },
    { key: 'contrast', label: 'Mask contrast', type: 'float', default: 1, min: 0.2, max: 5, step: 0.05 },
  ],
  evaluate(engine, inputs, p, o) {
    const a = inputs.a, b = inputs.b;
    if (!a || !b) throw new Error('Mixer: connect both color inputs');
    const out = engine.alloc(o.width, o.height, 'RGBA8');
    engine.run('mixer', () => `${HEADER}${SAMPLING}
uniform sampler2D uA; uniform sampler2D uB; uniform sampler2D uMask; uniform int uHasMask; uniform float uRatio; uniform float uContrast; out vec4 o;
void main() {
  vec4 a = sampleBilinear(uA, vUv), b = sampleBilinear(uB, vUv);
  float m = uHasMask == 1 ? sampleBilinear(uMask, vUv).r : 1.0;
  m = clamp((m - 0.5) * uContrast + 0.5, 0.0, 1.0) * uRatio;
  o = vec4(mix(a.rgb, b.rgb, m), 1.0);
}`, { uA: a, uB: b, uMask: inputs.mask ?? a, uHasMask: inputs.mask ? 1 : 0, uRatio: Number(p.ratio), uContrast: Number(p.contrast) }, out);
    const h = inputs.height;
    const res: Record<string, typeof out> = { color: out };
    if (h) res.height = engine.pool.retain(h);
    else { const flat = engine.alloc(o.width, o.height, 'R32F'); engine.fill(flat, [0.5, 0, 0, 1]); res.height = flat; }
    return res;
  },
};

export const COLOR_NODES: NodeDef[] = [SatMapNode, MixerNode];
