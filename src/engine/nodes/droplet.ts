import type { NodeDef } from '../types';
import type { Tex } from '../../gl/texture';
import { nextTick } from '../engine';
import { DROP_INIT, DROP_UPDATE, DROP_SPLAT_VS, DROP_SPLAT_FS, DROP_APPLY } from '../../shaders/droplet';
import { UNPACK_DELTA, APPLY_DELTA, EXTRACT_CHANNEL } from '../../shaders/erosion';

const QUALITY_CAP: Record<string, number> = { low: 1024, medium: 2048, high: 4096, ultra: 8192 };

export const DropletErosionNode: NodeDef = {
  type: 'erosion',
  title: 'Erosion',
  category: 'Erosion',
  description: 'Particle hydraulic erosion: millions of water droplets carve gullies, transport sediment and build fans. Outputs Flow, Wear and Deposit maps.',
  heavy: true,
  inputs: [
    { key: 'height', label: 'In', kind: 'height' },
    { key: 'mask', label: 'Mask', kind: 'height', optional: true },
  ],
  outputs: [
    { key: 'height', label: 'Out', kind: 'height' },
    { key: 'flow', label: 'Flow', kind: 'height', isMask: true },
    { key: 'wear', label: 'Wear', kind: 'height', isMask: true },
    { key: 'deposit', label: 'Deposit', kind: 'height', isMask: true },
  ],
  params: [
    { key: 'droplets', label: 'Droplets / cell', type: 'float', default: 8, min: 0.5, max: 100, step: 0.5, hint: 'Average droplets per cell; the time budget may lower it' },
    { key: 'quality', label: 'Detail', type: 'select', default: 'medium', options: [
      { value: 'low', label: 'Low (1K)' }, { value: 'medium', label: 'Medium (2K)' }, { value: 'high', label: 'High (4K)' }, { value: 'ultra', label: 'Ultra (full)' }] },
    { key: 'lifetime', label: 'Droplet lifetime', type: 'int', default: 48, min: 8, max: 256, step: 4 },
    { key: 'erode', label: 'Rock softness', type: 'float', default: 0.8, min: 0, max: 1, step: 0.01 },
    { key: 'deposit', label: 'Deposition', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01 },
    { key: 'capacity', label: 'Sediment capacity', type: 'float', default: 1.8, min: 0.1, max: 4, step: 0.05 },
    { key: 'inertia', label: 'Inertia', type: 'float', default: 0.1, min: 0, max: 0.95, step: 0.01, hint: 'Higher = straighter paths' },
    { key: 'gravity', label: 'Gravity', type: 'float', default: 4, min: 0.5, max: 10, step: 0.1 },
    { key: 'evaporation', label: 'Evaporation', type: 'float', default: 0.02, min: 0, max: 0.1, step: 0.001 },
    { key: 'radius', label: 'Brush radius', type: 'float', default: 2.5, min: 1, max: 6, step: 0.5, hint: 'Gully width in pixels at 2K' },
    { key: 'minSlope', label: 'Min slope', type: 'float', default: 0.01, min: 0, max: 0.2, step: 0.005 },
    { key: 'flowPower', label: 'Flow contrast', type: 'float', default: 0.5, min: 0.1, max: 1, step: 0.05 },
  ],
  async evaluate(engine, inputs, p, opts) {
    const base = inputs.height;
    if (!base) throw new Error('Erosion: no input height');
    const gl = engine.gl;
    const W = opts.width, H = opts.height;
    const cap = Math.min(QUALITY_CAP[String(p.quality)] ?? 2048, opts.preview ? 1024 : 1e9);
    const sw = Math.min(W, cap), sh = Math.round((H * sw) / W);
    const hs = opts.heightRatio * sw;
    const baseLow = sw === W ? engine.pool.retain(base) : engine.resample(base, sw, sh, 'R32F');
    let hA = engine.copy(baseLow, 'R32F');
    let hB = engine.alloc(sw, sh, 'R32F');
    let mapsA = engine.alloc(sw, sh, 'RGBA32F');
    let mapsB = engine.alloc(sw, sh, 'RGBA32F');
    engine.fill(mapsA, [0, 0, 0, 0]);
    const delta = engine.alloc(sw, sh, 'RGBA16F');
    engine.fill(delta, [0, 0, 0, 0]);

    // Particle pool: droplets in one batch all read the same height snapshot, so keep their
    // density well below one per cell or they over-erode the same spots and the field diverges.
    const count = Math.max(4096, Math.min(524288, Math.floor((sw * sh) / 8)));
    const PW = Math.min(1024, count), PH = Math.ceil(count / PW);
    const mk = () => engine.alloc(PW, PH, 'RGBA32F');
    let P = [mk(), mk(), mk()], Q = [mk(), mk(), mk()];
    const totalDroplets = Number(p.droplets) * sw * sh;
    const batches = Math.max(1, Math.round(totalDroplets / count));
    const lifetime = Number(p.lifetime) | 0;
    const radius = Math.max(1, Number(p.radius) * (sw / 2048));
    const uniforms = {
      uSimRes: [sw, sh], uHs: hs, uInertia: Number(p.inertia), uCapacity: Number(p.capacity) * 2.0, uDeposit: Number(p.deposit),
      uErode: Number(p.erode) * 0.5, uEvap: Number(p.evaporation), uGravity: Number(p.gravity), uMinSlope: Number(p.minSlope),
    };
    const splat = engine.programs.get('drop_splat', () => DROP_SPLAT_FS, DROP_SPLAT_VS);
    let done = 0;
    let budgetHit = false;
    for (let b = 0; b < batches; b++) {
      if (opts.cancelled()) throw new Error('cancelled');
      if (b > 0 && performance.now() > opts.deadline) { budgetHit = true; break; }
      engine.run('drop_init', () => DROP_INIT, { uSeed: (Number(p.seed ?? 0) | 0) + b * 7919 + 13, uSimRes: [sw, sh] }, P);
      for (let s = 0; s < lifetime; s++) {
        engine.run('drop_update', () => DROP_UPDATE, { uP0: P[0], uP1: P[1], uP2: P[2], uH: hA, uDens: delta, uMask: inputs.mask ?? hA, uHasMask: inputs.mask ? 1 : 0, ...uniforms }, Q);
        [P, Q] = [Q, P];
        // splat deltas (additive)
        engine.fill(delta, [0, 0, 0, 0]);
        engine.pool.bindTargets([delta]);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        splat.use();
        splat.set({ uP1: P[1], uP2: P[2], uPRes: new Int32Array([PW, PH]), uSimRes: [sw, sh], uRadius: radius });
        gl.drawArrays(gl.POINTS, 0, PW * PH);
        gl.disable(gl.BLEND);
        engine.pool.unbindTargets();
        engine.run('drop_apply', () => DROP_APPLY, { uH: hA, uDelta: delta, uMaps: mapsA, uInvHs: 1 / hs }, [hB, mapsB]);
        [hA, hB] = [hB, hA];
        [mapsA, mapsB] = [mapsB, mapsA];
      }
      done++;
      await engine.sync();
      opts.progress(done / batches, `Erosion: ${(done * count / 1e6).toFixed(1)}M droplets`);
      await nextTick();
    }
    for (const t of [...P, ...Q]) engine.release(t);
    engine.release(hB); engine.release(mapsB); engine.release(delta);

    // Output: base + upsampled delta (keeps full-res input detail above the simulation resolution)
    const dlt = engine.alloc(sw, sh, 'R32F');
    engine.run('erosion_unpack', () => UNPACK_DELTA, { uState: hA, uBase: baseLow, uInvHs: 1 }, dlt);
    const height = engine.alloc(W, H, 'R32F');
    engine.run('erosion_apply', () => APPLY_DELTA, { uBase: base, uDelta: dlt, uSameRes: sw === W ? 1 : 0 }, height);
    engine.release(dlt); engine.release(hA); engine.release(baseLow);
    const extract = (channel: number, power: number): Tex => {
      const raw = engine.alloc(sw, sh, 'R32F');
      engine.run('erosion_extract', () => EXTRACT_CHANNEL, { uSrc: mapsA, uChannel: channel, uScale: 1, uPower: 1, uRaw: 1 }, raw);
      const small = engine.resample(raw, Math.max(1, Math.round(sw / 6)), Math.max(1, Math.round(sh / 6)), 'R32F');
      const mm = engine.minMax(small);
      engine.release(small); engine.release(raw);
      const out = engine.alloc(W, H, 'R32F');
      engine.run('erosion_extract', () => EXTRACT_CHANNEL, { uSrc: mapsA, uChannel: channel, uScale: 1 / Math.max(mm.max, 1e-9), uPower: power, uRaw: 0 }, out);
      return out;
    };
    const flow = extract(2, Number(p.flowPower));
    const wear = extract(0, 0.6);
    const deposit = extract(1, 0.6);
    engine.release(mapsA);
    if (budgetHit) opts.progress(1, `Erosion stopped early by time budget (${(done * count / 1e6).toFixed(1)}M droplets)`);
    return { height, flow, wear, deposit };
  },
};
