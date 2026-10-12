import type { NodeDef, EvalOptions } from '../types';
import type { Engine } from '../engine';
import type { Tex } from '../../gl/texture';
import { nextTick } from '../engine';
import {
  PACK_STATE, FLUX_PASS, WATER_EROSION_PASS, ADVECT_PASS, UNPACK_DELTA, APPLY_DELTA, EXTRACT_CHANNEL, THERMAL_PASS,
} from '../../shaders/erosion';

const QUALITY_CAP: Record<string, number> = { low: 1024, medium: 2048, high: 4096, ultra: 8192 };

interface Level { w: number; h: number; iters: number; }

function planLevels(erosionW: number, erosionH: number, iterations: number): Level[] {
  const levels: Level[] = [];
  let w = erosionW, h = erosionH;
  while (true) {
    levels.unshift({ w: Math.round(w), h: Math.round(h), iters: iterations });
    if (w <= 400 || levels.length >= 4) break;
    w /= 2; h /= 2;
  }
  return levels;
}

export const ErosionNode: NodeDef = {
  type: 'erosion',
  title: 'Erosion',
  category: 'Erosion',
  description: 'Hydraulic erosion with sediment transport (virtual pipes), progressive multi-resolution. Outputs Flow, Wear and Deposit data maps.',
  heavy: true,
  inputs: [
    { key: 'height', label: 'In', kind: 'height' },
    { key: 'mask', label: 'Mask', kind: 'height', optional: true },
  ],
  outputs: [
    { key: 'height', label: 'Out', kind: 'height' },
    { key: 'flow', label: 'Flow', kind: 'height' },
    { key: 'wear', label: 'Wear', kind: 'height' },
    { key: 'deposit', label: 'Deposit', kind: 'height' },
  ],
  params: [
    { key: 'iterations', label: 'Duration', type: 'int', default: 400, min: 10, max: 4000, step: 10, hint: 'Iterations at the finest level; the build time budget may shorten this' },
    { key: 'quality', label: 'Detail', type: 'select', default: 'medium', options: [
      { value: 'low', label: 'Low (1K)' }, { value: 'medium', label: 'Medium (2K)' }, { value: 'high', label: 'High (4K)' }, { value: 'ultra', label: 'Ultra (full)' }],
      hint: 'Maximum simulation resolution; details are restored from the input above it' },
    { key: 'rain', label: 'Rain', type: 'float', default: 0.5, min: 0, max: 3, step: 0.01 },
    { key: 'softness', label: 'Rock softness', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01 },
    { key: 'capacity', label: 'Sediment capacity', type: 'float', default: 1.0, min: 0.05, max: 4, step: 0.05 },
    { key: 'deposition', label: 'Deposition', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01 },
    { key: 'evaporation', label: 'Evaporation', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01 },
    { key: 'downcutting', label: 'Downcutting', type: 'float', default: 0.5, min: 0.05, max: 1, step: 0.01, hint: 'Depth limit of channel erosion (lower = deeper channels)' },
    { key: 'thermal', label: 'Talus slippage', type: 'float', default: 0.25, min: 0, max: 0.5, step: 0.01 },
    { key: 'talusAngle', label: 'Talus angle', type: 'float', default: 38, min: 5, max: 80, step: 1 },
    { key: 'flowPower', label: 'Flow contrast', type: 'float', default: 0.5, min: 0.1, max: 1, step: 0.05 },
  ],
  async evaluate(engine, inputs, p, opts) {
    const base = inputs.height;
    if (!base) throw new Error('Erosion: no input height');
    const W = opts.width, H = opts.height;
    const cap = Math.min(QUALITY_CAP[String(p.quality)] ?? 2048, opts.preview ? 1024 : 1e9);
    const erosionW = Math.min(W, cap);
    const erosionH = Math.round((H * erosionW) / W);
    const levels = planLevels(erosionW, erosionH, Math.max(1, Number(p.iterations) | 0));

    const hsFor = (w: number) => opts.heightRatio * w;
    const rain = Number(p.rain) * 0.004;
    const uniforms = {
      uPipe: 0.9,
      uKc: Number(p.capacity) * 0.6,
      uKs: Number(p.softness) * 0.25,
      uKd: 0.05 + Number(p.deposition) * 0.5,
      uDepthMax: Number(p.downcutting) * 4.0,
      uMinSlope: 0.02,
      uThermal: Number(p.thermal),
      uTalus: Math.tan((Number(p.talusAngle) * Math.PI) / 180),
      uVmax: 3.0,
      uEvap: 0.005 + Number(p.evaporation) * 0.04,
      uRain: rain,
    };

    let delta: Tex | null = null;     // height delta in [0,1] units (previous level resolution)
    let prevState: Tex | null = null; // previous level final state
    let prevMaps: Tex | null = null;
    const totalCost = levels.reduce((s, l) => s + l.w * l.h * l.iters, 0);
    let doneCost = 0;
    let costPerPixelIter = 0; // ms
    let budgetHit = false;
    let itersRun = 0;

    for (let li = 0; li < levels.length; li++) {
      const L = levels[li];
      const hs = hsFor(L.w);
      const baseL = L.w === W && L.h === H ? engine.pool.retain(base) : engine.resample(base, L.w, L.h, 'R32F');
      const maskL = inputs.mask ? inputs.mask : null;

      let stateA = engine.alloc(L.w, L.h, 'RGBA32F');
      let stateB = engine.alloc(L.w, L.h, 'RGBA32F');
      let fluxA = engine.alloc(L.w, L.h, 'RGBA32F');
      let fluxB = engine.alloc(L.w, L.h, 'RGBA32F');
      const vel = engine.alloc(L.w, L.h, 'RGBA32F');
      let mapsA = engine.alloc(L.w, L.h, 'RGBA32F');
      let mapsB = engine.alloc(L.w, L.h, 'RGBA32F');
      engine.fill(fluxA, [0, 0, 0, 0]);
      engine.fill(vel, [0, 0, 0, 0]);

      engine.run('erosion_pack', () => PACK_STATE, {
        uBase: baseL, uDelta: delta ?? baseL, uPrev: prevState ?? baseL, uMask: maskL ?? baseL,
        uHasDelta: delta ? 1 : 0, uHasPrev: prevState ? 1 : 0, uHasMask: maskL ? 1 : 0, uHs: hs,
      }, stateA);
      if (prevMaps) {
        const up = engine.resample(prevMaps, L.w, L.h, 'RGBA32F');
        engine.release(mapsA);
        mapsA = up;
        // Discharge scales with cell size: coarse cells carried 2x the water per cell per axis.
        engine.release(prevMaps); prevMaps = null;
      } else {
        engine.fill(mapsA, [0, 0, 0, 0]);
      }
      if (prevState) { engine.release(prevState); prevState = null; }
      if (delta) { engine.release(delta); delta = null; }

      // Time budget: remaining cost share for this level.
      const remainingCost = levels.slice(li).reduce((s, l) => s + l.w * l.h * l.iters, 0);
      let planned = L.iters;
      const batch = L.w >= 2048 ? 2 : L.w >= 1024 ? 4 : 10;
      let i = 0;
      while (i < planned) {
        if (opts.cancelled()) throw new Error('cancelled');
        const n = Math.min(batch, planned - i);
        const t0 = performance.now();
        for (let k = 0; k < n; k++) {
          engine.run('erosion_flux', () => FLUX_PASS, { uState: stateA, uFlux: fluxA, uPipe: uniforms.uPipe }, fluxB);
          engine.run('erosion_water', () => WATER_EROSION_PASS, {
            uState: stateA, uFlux: fluxB, uMaps: mapsA,
            uKc: uniforms.uKc, uKs: uniforms.uKs, uKd: uniforms.uKd, uDepthMax: uniforms.uDepthMax, uMinSlope: uniforms.uMinSlope,
            uThermal: uniforms.uThermal, uTalus: uniforms.uTalus, uVmax: uniforms.uVmax,
          }, [stateB, vel, mapsB]);
          engine.run('erosion_advect', () => ADVECT_PASS, { uState: stateB, uVel: vel, uEvap: uniforms.uEvap, uRain: uniforms.uRain }, stateA);
          [fluxA, fluxB] = [fluxB, fluxA];
          [mapsA, mapsB] = [mapsB, mapsA];
        }
        await engine.sync();
        const dtMs = performance.now() - t0;
        i += n;
        itersRun += n;
        doneCost += n * L.w * L.h;
        const measured = dtMs / (n * L.w * L.h);
        costPerPixelIter = costPerPixelIter === 0 ? measured : costPerPixelIter * 0.7 + measured * 0.3;
        // Re-plan this level's iteration count against the deadline.
        const now = performance.now();
        const timeLeft = (opts.deadline - now) * opts.timeShare;
        const levelShare = timeLeft * ((L.w * L.h * (L.iters - i)) / Math.max(remainingCost - doneCost + (li === 0 ? 0 : 0), 1));
        const affordable = i + Math.floor(Math.max(levelShare, 0) / (costPerPixelIter * L.w * L.h));
        if (affordable < planned) { planned = Math.max(i, affordable); budgetHit = true; }
        opts.progress(doneCost / totalCost, `Erosion ${L.w}×${L.h}: ${i}/${planned} iterations`);
        await nextTick();
      }

      // Height delta for the next level / final output.
      delta = engine.alloc(L.w, L.h, 'R32F');
      engine.run('erosion_unpack', () => UNPACK_DELTA, { uState: stateA, uBase: baseL, uInvHs: 1 / hs }, delta);
      prevState = stateA;
      prevMaps = mapsA;
      engine.release(stateB); engine.release(fluxA); engine.release(fluxB); engine.release(vel); engine.release(mapsB);
      engine.release(baseL);
    }

    const height = engine.alloc(W, H, 'R32F');
    engine.run('erosion_apply', () => APPLY_DELTA, { uBase: base, uDelta: delta!, uSameRes: delta!.width === W ? 1 : 0 }, height);
    engine.release(delta);
    engine.release(prevState);

    // Data maps normalised to [0,1].
    // Normalise each map by the maximum of a box-filtered copy so single-pixel outliers do not crush the range.
    const extract = (channel: number, power: number): Tex => {
      const raw = engine.alloc(prevMaps!.width, prevMaps!.height, 'R32F');
      engine.run('erosion_extract', () => EXTRACT_CHANNEL, { uSrc: prevMaps!, uChannel: channel, uScale: 1, uPower: 1, uRaw: 1 }, raw);
      const small = engine.resample(raw, Math.max(1, Math.round(raw.width / 6)), Math.max(1, Math.round(raw.height / 6)), 'R32F');
      const mm = engine.minMax(small);
      engine.release(small);
      engine.release(raw);
      const out = engine.alloc(W, H, 'R32F');
      engine.run('erosion_extract', () => EXTRACT_CHANNEL, { uSrc: prevMaps!, uChannel: channel, uScale: 1 / Math.max(mm.max, 1e-9), uPower: power, uRaw: 0 }, out);
      return out;
    };
    const flowPow = Number(p.flowPower);
    const flow = extract(2, flowPow);
    const wear = extract(0, 0.6);
    const deposit = extract(1, 0.6);
    engine.release(prevMaps);
    if (budgetHit) opts.progress(1, `Erosion stopped early by time budget (${itersRun} iterations total)`);
    return { height, flow, wear, deposit };
  },
};

export const ThermalNode: NodeDef = {
  type: 'thermal',
  title: 'Thermal',
  category: 'Erosion',
  description: 'Talus slippage: material above the angle of repose slides downhill, producing scree slopes.',
  heavy: true,
  inputs: [
    { key: 'height', label: 'In', kind: 'height' },
    { key: 'mask', label: 'Mask', kind: 'height', optional: true },
  ],
  outputs: [{ key: 'height', label: 'Out', kind: 'height' }],
  params: [
    { key: 'iterations', label: 'Duration', type: 'int', default: 60, min: 1, max: 500, step: 1 },
    { key: 'angle', label: 'Talus angle', type: 'float', default: 35, min: 5, max: 80, step: 1 },
    { key: 'rate', label: 'Rate', type: 'float', default: 0.4, min: 0.01, max: 0.5, step: 0.01 },
  ],
  async evaluate(engine, inputs, p, opts) {
    const src = inputs.height;
    if (!src) throw new Error('Thermal: no input');
    return { height: await runThermal(engine, src, inputs.mask, Number(p.iterations) | 0, Number(p.angle), Number(p.rate), opts) };
  },
};

export async function runThermal(engine: Engine, src: Tex, mask: Tex | null, iterations: number, angle: number, rate: number, opts: EvalOptions): Promise<Tex> {
  const W = src.width, H = src.height;
  const hs = opts.heightRatio * W;
  let a = engine.copy(src, 'R32F');
  let b = engine.alloc(W, H, 'R32F');
  const tan = Math.tan((angle * Math.PI) / 180);
  const batch = W >= 2048 ? 4 : 12;
  for (let i = 0; i < iterations; i += batch) {
    if (opts.cancelled()) throw new Error('cancelled');
    const n = Math.min(batch, iterations - i);
    for (let k = 0; k < n; k++) {
      engine.run('thermal', () => THERMAL_PASS, { uH: a, uMask: mask ?? a, uHasMask: mask ? 1 : 0, uHs: hs, uRate: rate, uTalus: tan }, b);
      [a, b] = [b, a];
    }
    await engine.sync();
    opts.progress((i + n) / iterations, `Thermal: ${i + n}/${iterations}`);
    if (performance.now() > opts.deadline) break;
    await nextTick();
  }
  engine.release(b);
  return a;
}

export const EROSION_NODES: NodeDef[] = [ErosionNode, ThermalNode];
