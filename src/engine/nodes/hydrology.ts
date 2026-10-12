import type { NodeDef, EvalOptions } from '../types';
import type { Engine } from '../engine';
import type { Tex } from '../../gl/texture';
import { nextTick } from '../engine';
import { HEADER, SAMPLING } from '../../shaders/common';
import { FILL_INIT, FILL_ITER, FLOW_DIR, FLOW_ACC, FLOW_INIT, FLOW_FINISH } from '../../shaders/hydrology';
import { blur } from './modifiers';

function pyramid(W: number, H: number, minW = 256): { w: number; h: number }[] {
  const levels: { w: number; h: number }[] = [];
  let w = W, h = H;
  while (true) {
    levels.unshift({ w: Math.round(w), h: Math.round(h) });
    if (w <= minW * 1.5 || levels.length >= 6) break;
    w /= 2; h /= 2;
  }
  return levels;
}

/**
 * Depression filling + D8 flow accumulation on a resolution pyramid.
 * Coarse levels converge fully (iterations ~ width); finer levels refine an upsampled solution.
 */
export async function computeFlow(engine: Engine, height: Tex, opts: EvalOptions, cap: number, label: string): Promise<{ A: Tex; W: Tex; dir: Tex }> {
  const W0 = Math.min(height.width, cap);
  const H0 = Math.round((height.height * W0) / height.width);
  const levels = pyramid(W0, H0);
  let prevW: Tex | null = null;
  let prevA: Tex | null = null;
  let prevDir: Tex | null = null;
  const eps = 2e-5;
  for (let li = 0; li < levels.length; li++) {
    const L = levels[li];
    // Budget: once the deadline has passed, keep the coarser solution (it is upsampled on output).
    if (li > 0 && performance.now() > opts.deadline) { opts.progress(1, `${label} stopped at ${levels[li - 1].w}×${levels[li - 1].h} by time budget`); break; }
    const h = L.w === height.width ? engine.pool.retain(height) : engine.resample(height, L.w, L.h, 'R32F');
    // --- fill ---
    let wA = engine.alloc(L.w, L.h, 'R32F');
    let wB = engine.alloc(L.w, L.h, 'R32F');
    engine.run('fill_init', () => FILL_INIT, { uH: h, uPrev: prevW ?? h, uHasPrev: prevW ? 1 : 0 }, wA);
    const fillIters = li === 0 ? Math.max(L.w, L.h) * 2 : 120;
    for (let i = 0; i < fillIters; i++) {
      engine.run('fill_iter', () => FILL_ITER, { uH: h, uW: wA, uEps: eps * (height.width / L.w) }, wB);
      [wA, wB] = [wB, wA];
      if (i % 40 === 39) { await engine.sync(); if (opts.cancelled()) throw new Error('cancelled'); await nextTick(); }
    }
    engine.release(wB);
    // --- direction + accumulation ---
    const dir = engine.alloc(L.w, L.h, 'R32F');
    engine.run('flow_dir', () => FLOW_DIR, { uW: wA }, dir);
    let aA = engine.alloc(L.w, L.h, 'R32F');
    let aB = engine.alloc(L.w, L.h, 'R32F');
    engine.run('flow_init', () => FLOW_INIT, { uPrev: prevA ?? h, uHasPrev: prevA ? 1 : 0, uScale: prevA ? (L.w / prevA.width) * (L.h / prevA.height) : 1 }, aA);
    const accIters = li === 0 ? Math.max(L.w, L.h) * 2 : 80;
    for (let i = 0; i < accIters; i++) {
      engine.run('flow_acc', () => FLOW_ACC, { uDir: dir, uA: aA }, aB);
      [aA, aB] = [aB, aA];
      if (i % 40 === 39) { await engine.sync(); if (opts.cancelled()) throw new Error('cancelled'); await nextTick(); }
    }
    engine.release(aB);
    engine.release(h);
    if (prevW) engine.release(prevW);
    if (prevA) engine.release(prevA);
    if (prevDir) engine.release(prevDir);
    prevW = wA; prevA = aA; prevDir = dir;
    opts.progress((li + 1) / levels.length, `${label} ${L.w}×${L.h}`);
    await engine.sync();
    await nextTick();
  }
  return { A: prevA!, W: prevW!, dir: prevDir! };
}

export const FlowNode: NodeDef = {
  type: 'flow',
  title: 'Flow',
  category: 'Data',
  description: 'Drainage analysis: fills depressions, routes water downhill (D8) and accumulates flow. Outputs flow map, lake mask and the filled height.',
  heavy: true,
  inputs: [{ key: 'height', label: 'In', kind: 'height' }],
  outputs: [
    { key: 'flow', label: 'Flow', kind: 'height', isMask: true },
    { key: 'lakes', label: 'Lakes', kind: 'height', isMask: true },
    { key: 'height', label: 'Filled', kind: 'height' },
  ],
  params: [
    { key: 'quality', label: 'Detail', type: 'select', default: 'medium', options: [
      { value: 'low', label: 'Low (1K)' }, { value: 'medium', label: 'Medium (2K)' }, { value: 'high', label: 'High (4K)' }, { value: 'ultra', label: 'Ultra (full)' }] },
    { key: 'contrast', label: 'Contrast', type: 'float', default: 1.5, min: 0.3, max: 4, step: 0.05, hint: 'Power curve on log(accumulation)' },
    { key: 'lakeDepth', label: 'Min lake depth', type: 'float', default: 0.015, min: 0.0005, max: 0.1, step: 0.0005, hint: 'Shallower depressions are not treated as lakes' },
  ],
  async evaluate(engine, inputs, p, opts) {
    const h = inputs.height;
    if (!h) throw new Error('Flow: input not connected');
    const caps: Record<string, number> = { low: 1024, medium: 2048, high: 4096, ultra: 1e9 };
    const cap = Math.min(caps[String(p.quality)] ?? 2048, opts.preview ? 1024 : 1e9);
    const { A, W, dir } = await computeFlow(engine, h, opts, cap, 'Flow');
    engine.release(dir);
    const mm = engine.minMax(A);
    const flow = engine.alloc(h.width, h.height, 'R32F');
    const lakes = engine.alloc(h.width, h.height, 'R32F');
    const filled = engine.alloc(h.width, h.height, 'R32F');
    engine.run('flow_finish', () => FLOW_FINISH, { uA: A, uW: W, uH: h, uLogMax: Math.log(Math.max(mm.max, 2)), uPower: Number(p.contrast), uLakeMin: Number(p.lakeDepth) }, [flow, lakes, filled]);
    engine.release(A); engine.release(W);
    return { flow, lakes, height: filled };
  },
};

export const RiversNode: NodeDef = {
  type: 'rivers',
  title: 'Rivers',
  category: 'Erosion',
  description: 'Carves river channels where a Flow map exceeds a threshold. Outputs the carved height and a river mask.',
  inputs: [
    { key: 'height', label: 'In', kind: 'height' },
    { key: 'flow', label: 'Flow', kind: 'height' },
  ],
  outputs: [{ key: 'height', label: 'Out', kind: 'height' }, { key: 'rivers', label: 'Rivers', kind: 'height', isMask: true }],
  params: [
    { key: 'threshold', label: 'Threshold', type: 'float', default: 0.55, min: 0.05, max: 1, step: 0.01, hint: 'Flow value where rivers start' },
    { key: 'width', label: 'Width', type: 'float', default: 0.002, min: 0, max: 0.02, step: 0.0005, hint: 'Fraction of map width' },
    { key: 'depth', label: 'Depth', type: 'float', default: 0.02, min: 0, max: 0.2, step: 0.001 },
    { key: 'valley', label: 'Valley width', type: 'float', default: 0.008, min: 0, max: 0.05, step: 0.0005, hint: 'Soft valley carved around the channel' },
    { key: 'valleyDepth', label: 'Valley depth', type: 'float', default: 0.02, min: 0, max: 0.2, step: 0.001 },
  ],
  evaluate(engine, inputs, p, o) {
    const h = inputs.height, f = inputs.flow;
    if (!h || !f) throw new Error('Rivers: connect height and flow');
    const th = Number(p.threshold);
    const mask0 = engine.alloc(o.width, o.height, 'R32F');
    engine.run('river_mask', () => `${HEADER}${SAMPLING}
uniform sampler2D uF; uniform float uTh; out vec4 o;
void main() { o = vec4(smoothstep(uTh - 0.04, uTh + 0.04, sampleBilinear(uF, vUv).r), 0.0, 0.0, 1.0); }`, { uF: f, uTh: th }, mask0);
    const channel = blur(engine, mask0, Number(p.width));
    const valley = blur(engine, mask0, Number(p.valley));
    const out = engine.alloc(o.width, o.height, 'R32F');
    const rivers = engine.alloc(o.width, o.height, 'R32F');
    engine.run('river_carve', () => `${HEADER}${SAMPLING}
uniform sampler2D uH; uniform sampler2D uC; uniform sampler2D uV; uniform sampler2D uM; uniform float uDepth; uniform float uVDepth;
layout(location = 0) out vec4 oH; layout(location = 1) out vec4 oR;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float h = texelFetch(uH, p, 0).r;
  float c = clamp(texelFetch(uC, p, 0).r * 2.0, 0.0, 1.0);
  float v = clamp(texelFetch(uV, p, 0).r * 2.0, 0.0, 1.0);
  float m = texelFetch(uM, p, 0).r;
  float carve = uVDepth * v * v * (3.0 - 2.0 * v) + uDepth * c;
  oH = vec4(max(h - carve, 0.0), 0.0, 0.0, 1.0);
  oR = vec4(max(m, smoothstep(0.35, 0.6, c)), 0.0, 0.0, 1.0);
}`, { uH: h, uC: channel, uV: valley, uM: mask0, uDepth: Number(p.depth), uVDepth: Number(p.valleyDepth) }, [out, rivers]);
    engine.release(mask0); engine.release(channel); engine.release(valley);
    return { height: out, rivers };
  },
};

export const SeaNode: NodeDef = {
  type: 'sea',
  title: 'Sea',
  category: 'Modifier',
  description: 'Sea level with a shore: terrain below the level is flattened into a shallow seabed. Outputs height and a water mask.',
  inputs: [{ key: 'height', label: 'In', kind: 'height' }],
  outputs: [{ key: 'height', label: 'Out', kind: 'height' }, { key: 'water', label: 'Water', kind: 'height', isMask: true }],
  params: [
    { key: 'level', label: 'Sea level', type: 'float', default: 0.12, min: 0, max: 1, step: 0.005 },
    { key: 'seabed', label: 'Seabed relief', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, hint: 'How much underwater relief is kept' },
    { key: 'shore', label: 'Shore softness', type: 'float', default: 0.02, min: 0, max: 0.2, step: 0.005 },
  ],
  evaluate(engine, inputs, p, o) {
    const h = inputs.height;
    if (!h) throw new Error('Sea: input not connected');
    const out = engine.alloc(o.width, o.height, 'R32F');
    const water = engine.alloc(o.width, o.height, 'R32F');
    engine.run('sea', () => `${HEADER}
uniform sampler2D uH; uniform float uLevel; uniform float uBed; uniform float uShore;
layout(location = 0) out vec4 oH; layout(location = 1) out vec4 oW;
void main() {
  float h = texelFetch(uH, ivec2(gl_FragCoord.xy), 0).r;
  float under = max(uLevel - h, 0.0);
  float hb = uLevel - under * uBed;
  // soften the shoreline so beaches are not a hard crease
  float t = smoothstep(-uShore, uShore, h - uLevel);
  float hh = mix(hb, h, t);
  oH = vec4(hh, 0.0, 0.0, 1.0);
  oW = vec4(1.0 - smoothstep(uLevel - 0.002, uLevel + 0.002, h), 0.0, 0.0, 1.0);
}`, { uH: h, uLevel: Number(p.level), uBed: Number(p.seabed), uShore: Math.max(Number(p.shore), 1e-4) }, [out, water]);
    return { height: out, water };
  },
};


/** Stream-power erosion step on the simulation grid, with hillslope diffusion. */
const FLUVIAL_STEP = `${HEADER}${SAMPLING}
uniform sampler2D uH; uniform sampler2D uA; uniform sampler2D uDir; uniform sampler2D uMask; uniform int uHasMask;
uniform float uK; uniform float uM; uniform float uDiff; uniform float uHs; uniform float uAref;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float h = texelFetch(uH, p, 0).r;
  float m = uHasMask == 1 ? sampleBilinear(uMask, vUv).r : 1.0;
  int d = int(texelFetch(uDir, p, 0).r);
  float hn = h; float dist = 1.0;
  if (d >= 0) {
    int k = d < 4 ? d : d + 1;           // skip the centre slot
    ivec2 off = ivec2(k % 3 - 1, k / 3 - 1);
    hn = fetchC(uH, p + off).r;
    dist = (off.x != 0 && off.y != 0) ? 1.41421356 : 1.0;
  }
  // Implicit stream-power step (Braun & Willett style): h' = (h + c*hn) / (1 + c), c = K A^m / dist.
  // Unconditionally stable and never overshoots the receiver, so big rivers grade smoothly instead
  // of being clamped into flat floors.
  float a = max(texelFetch(uA, p, 0).r, 1.0) / uAref;
  float c = (d >= 0 && hn < h) ? uK * pow(a, uM) * m / dist : 0.0;
  float hh = (h + c * hn) / (1.0 + c);
  // hillslope diffusion: smooths small bumps, rounds crests, keeps valleys
  float l = fetchC(uH, p + ivec2(-1, 0)).r + fetchC(uH, p + ivec2(1, 0)).r + fetchC(uH, p + ivec2(0, -1)).r + fetchC(uH, p + ivec2(0, 1)).r;
  hh += uDiff * m * (l * 0.25 - h);
  o = vec4(hh, 0.0, 0.0, 1.0);
}`;

const FLUVIAL_OUT = `${HEADER}${SAMPLING}
uniform sampler2D uBase; uniform sampler2D uBaseLow; uniform sampler2D uSim; uniform float uKeep; uniform float uLo; uniform float uHi;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float base = texelFetch(uBase, p, 0).r;
  float sim = uLo + sampleBicubic(uSim, vUv).r * (uHi - uLo);
  float low = sampleBicubic(uBaseLow, vUv).r;
  // detail = what the input had above the simulation resolution; keep a fraction of it
  o = vec4(max(sim + (base - low) * uKeep, 0.0), 0.0, 0.0, 1.0);
}`;

export const FluvialNode: NodeDef = {
  type: 'fluvial',
  title: 'Fluvial',
  category: 'Erosion',
  description: 'Landscape-evolution erosion: rivers cut valleys in proportion to drainage area and slope while hillslope diffusion smooths small bumps. Produces realistic ridge-and-valley mountain ranges fast.',
  heavy: true,
  inputs: [
    { key: 'height', label: 'In', kind: 'height' },
    { key: 'mask', label: 'Mask', kind: 'height', optional: true },
  ],
  outputs: [{ key: 'height', label: 'Out', kind: 'height' }, { key: 'flow', label: 'Flow', kind: 'height', isMask: true }],
  params: [
    { key: 'rounds', label: 'Rounds', type: 'int', default: 10, min: 1, max: 60, step: 1, hint: 'Flow is re-routed each round' },
    { key: 'steps', label: 'Steps / round', type: 'int', default: 8, min: 1, max: 30, step: 1 },
    { key: 'strength', label: 'Incision', type: 'float', default: 0.5, min: 0, max: 2, step: 0.01 },
    { key: 'exponent', label: 'Area exponent', type: 'float', default: 0.5, min: 0.2, max: 1, step: 0.05, hint: 'Higher favours big rivers over small streams' },
    { key: 'diffusion', label: 'Smoothing', type: 'float', default: 0.04, min: 0, max: 0.25, step: 0.005, hint: 'Hillslope diffusion per step; high values melt ridges' },
    { key: 'detail', label: 'Keep input detail', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, hint: 'Fine detail of the input above the simulation resolution' },
    { key: 'quality', label: 'Detail', type: 'select', default: 'low', options: [
      { value: 'low', label: 'Low (1K)' }, { value: 'medium', label: 'Medium (2K)' }, { value: 'high', label: 'High (4K)' }] },
  ],
  async evaluate(engine, inputs, p, opts) {
    const base = inputs.height;
    if (!base) throw new Error('Fluvial: input not connected');
    const caps: Record<string, number> = { low: 1024, medium: 2048, high: 4096 };
    const cap = Math.min(caps[String(p.quality)] ?? 1024, opts.preview ? 768 : 1e9);
    const W = Math.min(base.width, cap), H = Math.round((base.height * W) / base.width);
    const baseLow = W === base.width ? engine.pool.retain(base) : engine.resample(base, W, H, 'R32F');
    let hA = engine.copy(baseLow, 'R32F');
    let hB = engine.alloc(W, H, 'R32F');
    const rounds = Number(p.rounds) | 0, steps = Number(p.steps) | 0;
    const hs = opts.heightRatio * W;
    const uniforms = { uK: Number(p.strength) * 0.08, uM: Number(p.exponent), uDiff: Number(p.diffusion), uHs: hs, uAref: W * 0.5 };
    const inRange = engine.minMax(baseLow);
    let flowTex: Tex | null = null;
    let done = 0;
    for (let r = 0; r < rounds; r++) {
      if (opts.cancelled()) throw new Error('cancelled');
      if (r > 0 && performance.now() > opts.deadline) { opts.progress(1, `Fluvial stopped early by time budget (${done}/${rounds} rounds)`); break; }
      const { A, W: Wfill, dir } = await computeFlow(engine, hA, { ...opts, progress: () => {} }, W, 'Fluvial');
      engine.release(Wfill);
      for (let k = 0; k < steps; k++) {
        engine.run('fluvial_step', () => FLUVIAL_STEP, { uH: hA, uA: A, uDir: dir, uMask: inputs.mask ?? hA, uHasMask: inputs.mask ? 1 : 0, ...uniforms }, hB);
        [hA, hB] = [hB, hA];
      }
      if (flowTex) engine.release(flowTex);
      flowTex = A;
      engine.release(dir);
      done++;
      await engine.sync();
      opts.progress(done / rounds, `Fluvial round ${done}/${rounds}`);
      await nextTick();
    }
    engine.release(hB);
    // Erosion lowers everything; stretch the result back to the input's range (stands in for uplift).
    const sim = engine.normalize(hA, undefined, undefined);
    engine.release(hA);
    const out = engine.alloc(base.width, base.height, 'R32F');
    engine.run('fluvial_out', () => FLUVIAL_OUT, { uBase: base, uBaseLow: baseLow, uSim: sim, uKeep: Number(p.detail), uLo: inRange.min, uHi: inRange.max }, out);
    engine.release(sim); engine.release(baseLow);
    // Flow map output (log-normalised)
    const flow = engine.alloc(base.width, base.height, 'R32F');
    if (flowTex) {
      const mm = engine.minMax(flowTex);
      engine.run('fluvial_flow', () => `${HEADER}${SAMPLING}
uniform sampler2D uA; uniform float uLogMax; out vec4 o;
void main() { float a = sampleBilinear(uA, vUv).r; o = vec4(pow(clamp(log(max(a, 1.0)) / uLogMax, 0.0, 1.0), 1.5), 0.0, 0.0, 1.0); }`, { uA: flowTex, uLogMax: Math.log(Math.max(mm.max, 2)) }, flow);
      engine.release(flowTex);
    } else engine.fill(flow, [0, 0, 0, 1]);
    return { height: out, flow };
  },
};

export const HYDROLOGY_NODES: NodeDef[] = [FluvialNode, FlowNode, RiversNode, SeaNode];
