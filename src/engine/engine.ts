import { GLContext } from '../gl/context';
import { TexturePool, type Tex, type TexFormat } from '../gl/texture';
import { ProgramCache, type UniformValue } from '../gl/program';
import { HEADER, SAMPLING } from '../shaders/common';

/** Execution context handed to node evaluators. */
export class Engine {
  readonly gl: WebGL2RenderingContext;
  readonly pool: TexturePool;
  readonly programs: ProgramCache;

  constructor(readonly ctx: GLContext) {
    this.gl = ctx.gl;
    this.pool = new TexturePool(ctx);
    this.programs = new ProgramCache(ctx);
  }

  /** Run a fullscreen fragment shader into one or more targets. */
  run(name: string, source: () => string, uniforms: Record<string, UniformValue>, targets: Tex | Tex[]): void {
    const list = Array.isArray(targets) ? targets : [targets];
    const prog = this.programs.get(name, source);
    prog.use();
    prog.set({ ...uniforms, uRes: [list[0].width, list[0].height] });
    this.pool.bindTargets(list);
    this.ctx.drawQuad();
    this.pool.unbindTargets();
  }

  alloc(w: number, h: number, format: TexFormat = 'R32F'): Tex {
    return this.pool.acquire(w, h, format);
  }

  release(t: Tex | null | undefined): void {
    if (t) this.pool.release(t);
  }

  /** Copy / resample a texture into a new target of any size (bicubic when upsampling, box when downsampling). */
  resample(src: Tex, w: number, h: number, format: TexFormat = src.format): Tex {
    const out = this.alloc(w, h, format);
    const down = w < src.width || h < src.height;
    this.run('resample_' + (down ? 'box' : 'cubic'), () => `${HEADER}${SAMPLING}
uniform sampler2D uSrc;
uniform int uDown;
out vec4 o;
void main() {
  if (uDown == 1) {
    // Box filter over the source footprint of this output pixel.
    vec2 sr = vec2(textureSize(uSrc, 0));
    vec2 scale = sr / vec2(uRes);
    vec2 p0 = vUv * sr - 0.5 * scale;
    ivec2 n = max(ivec2(ceil(scale)), ivec2(1));
    vec4 acc = vec4(0.0);
    float cnt = 0.0;
    for (int y = 0; y < 16; y++) { if (y >= n.y) break;
      for (int x = 0; x < 16; x++) { if (x >= n.x) break;
        acc += fetchC(uSrc, ivec2(floor(p0 + (vec2(x, y) + 0.5) * scale / vec2(n))));
        cnt += 1.0;
      } }
    o = acc / cnt;
  } else {
    o = sampleBicubic(uSrc, vUv);
  }
}`, { uSrc: src, uDown: down ? 1 : 0 }, out);
    return out;
  }

  /** Exact copy (same size). */
  copy(src: Tex, format: TexFormat = src.format): Tex {
    const out = this.alloc(src.width, src.height, format);
    this.run('copy', () => `${HEADER}
uniform sampler2D uSrc;
out vec4 o;
void main() { o = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0); }`, { uSrc: src }, out);
    return out;
  }

  fill(t: Tex, value: [number, number, number, number]): void {
    const gl = this.gl;
    this.pool.bindTargets([t]);
    gl.clearColor(value[0], value[1], value[2], value[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.pool.unbindTargets();
  }

  /** Min / max of the red channel via GPU reduction. */
  minMax(src: Tex): { min: number; max: number } {
    // First pass: convert to RG (min,max) at reduced size; subsequent passes reduce 4x4 blocks.
    let cur: Tex | null = null;
    let w = src.width, h = src.height;
    let input: Tex = src;
    let first = true;
    while (true) {
      const nw = Math.max(1, Math.ceil(w / 4));
      const nh = Math.max(1, Math.ceil(h / 4));
      const out = this.alloc(nw, nh, 'RGBA32F');
      this.run('reduce_minmax', () => `${HEADER}
uniform sampler2D uSrc;
uniform int uFirst;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) * 4;
  ivec2 sr = textureSize(uSrc, 0);
  float mn = 1e30, mx = -1e30;
  for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) {
    ivec2 q = p + ivec2(x, y);
    if (q.x >= sr.x || q.y >= sr.y) continue;
    vec4 v = texelFetch(uSrc, q, 0);
    if (uFirst == 1) { mn = min(mn, v.r); mx = max(mx, v.r); }
    else { mn = min(mn, v.r); mx = max(mx, v.g); }
  }
  o = vec4(mn, mx, 0.0, 1.0);
}`, { uSrc: input, uFirst: first ? 1 : 0 }, out);
      if (cur) this.release(cur);
      cur = out;
      first = false;
      input = out;
      w = nw; h = nh;
      if (w <= 4 && h <= 4) break;
    }
    const data = this.pool.readFloat(cur!);
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < cur!.width * cur!.height; i++) {
      mn = Math.min(mn, data[i * 4]);
      mx = Math.max(mx, data[i * 4 + 1]);
    }
    this.release(cur);
    return { min: mn, max: mx };
  }

  /** Normalize red channel to [0,1] (new texture). */
  normalize(src: Tex, lo?: number, hi?: number): Tex {
    const mm = lo === undefined || hi === undefined ? this.minMax(src) : { min: lo, max: hi };
    const out = this.alloc(src.width, src.height, 'R32F');
    const range = Math.max(mm.max - mm.min, 1e-9);
    this.run('normalize', () => `${HEADER}
uniform sampler2D uSrc; uniform float uMin; uniform float uInvRange;
out vec4 o;
void main() { float v = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0).r; o = vec4(clamp((v - uMin) * uInvRange, 0.0, 1.0), 0.0, 0.0, 1.0); }`,
      { uSrc: src, uMin: mm.min, uInvRange: 1 / range }, out);
    return out;
  }

  /** Wait for GPU completion. */
  sync(): Promise<void> {
    return this.ctx.sync();
  }
}

/** Frame yield so the UI can update during long builds. */
export function nextTick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}
