import type { GLContext } from './context';

export type TexFormat = 'R32F' | 'RG32F' | 'RGBA32F' | 'RGBA16F' | 'RGBA8';

export interface Tex {
  readonly id: number;
  readonly tex: WebGLTexture;
  readonly width: number;
  readonly height: number;
  readonly format: TexFormat;
  /** Reference count managed by the node cache; pool reclaims at 0. */
  refs: number;
}

interface FormatInfo {
  internal: number;
  format: number;
  type: number;
  bytes: number;
}

function formatInfo(gl: WebGL2RenderingContext, f: TexFormat): FormatInfo {
  switch (f) {
    case 'R32F':
      return { internal: gl.R32F, format: gl.RED, type: gl.FLOAT, bytes: 4 };
    case 'RG32F':
      return { internal: gl.RG32F, format: gl.RG, type: gl.FLOAT, bytes: 8 };
    case 'RGBA32F':
      return { internal: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT, bytes: 16 };
    case 'RGBA16F':
      return { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, bytes: 8 };
    case 'RGBA8':
      return { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, bytes: 4 };
  }
}

/**
 * Texture + framebuffer pool. All textures use NEAREST filtering and CLAMP wrap;
 * bilinear sampling of float data is done manually in shaders so OES_texture_float_linear
 * is never required.
 */
export class TexturePool {
  private free = new Map<string, Tex[]>();
  private nextId = 1;
  private fbo: WebGLFramebuffer;
  private live = new Set<Tex>();
  bytesAllocated = 0;

  constructor(private ctx: GLContext) {
    const fb = ctx.gl.createFramebuffer();
    if (!fb) throw new Error('Failed to create framebuffer');
    this.fbo = fb;
  }

  private key(w: number, h: number, f: TexFormat): string {
    return `${w}x${h}:${f}`;
  }

  acquire(width: number, height: number, format: TexFormat): Tex {
    const k = this.key(width, height, format);
    const list = this.free.get(k);
    if (list && list.length) {
      const t = list.pop()!;
      t.refs = 1;
      this.live.add(t);
      return t;
    }
    const gl = this.ctx.gl;
    const info = formatInfo(gl, format);
    const tex = gl.createTexture();
    if (!tex) throw new Error('Failed to create texture');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, info.internal, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    const err = gl.getError();
    if (err !== gl.NO_ERROR) {
      gl.deleteTexture(tex);
      throw new Error(`Texture allocation failed (${width}x${height} ${format}); GPU memory may be exhausted.`);
    }
    this.bytesAllocated += width * height * info.bytes;
    const t: Tex = { id: this.nextId++, tex, width, height, format, refs: 1 };
    this.live.add(t);
    return t;
  }

  retain(t: Tex): Tex {
    t.refs++;
    return t;
  }

  release(t: Tex): void {
    if (!this.live.has(t)) return;
    t.refs--;
    if (t.refs > 0) return;
    this.live.delete(t);
    const k = this.key(t.width, t.height, t.format);
    let list = this.free.get(k);
    if (!list) this.free.set(k, (list = []));
    list.push(t);
  }

  /** Delete pooled (free) textures to give memory back to the driver. */
  trim(): void {
    const gl = this.ctx.gl;
    for (const [, list] of this.free) {
      for (const t of list) {
        gl.deleteTexture(t.tex);
        this.bytesAllocated -= t.width * t.height * formatInfo(gl, t.format).bytes;
      }
    }
    this.free.clear();
  }

  /** Bind one or more textures as render targets (MRT). */
  bindTargets(targets: Tex[]): void {
    const gl = this.ctx.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    const bufs: number[] = [];
    for (let i = 0; i < 6; i++) {
      const t = targets[i];
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t ? t.tex : null, 0);
      if (t) bufs.push(gl.COLOR_ATTACHMENT0 + i);
    }
    gl.drawBuffers(bufs);
    gl.viewport(0, 0, targets[0].width, targets[0].height);
  }

  unbindTargets(): void {
    const gl = this.ctx.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Read back a texture's full contents as RGBA floats (format-independent, slow). */
  readFloat(t: Tex): Float32Array {
    const gl = this.ctx.gl;
    this.bindTargets([t]);
    const out = new Float32Array(t.width * t.height * 4);
    gl.readPixels(0, 0, t.width, t.height, gl.RGBA, gl.FLOAT, out);
    this.unbindTargets();
    return out;
  }

  readBytes(t: Tex): Uint8Array {
    const gl = this.ctx.gl;
    this.bindTargets([t]);
    const out = new Uint8Array(t.width * t.height * 4);
    gl.readPixels(0, 0, t.width, t.height, gl.RGBA, gl.UNSIGNED_BYTE, out);
    this.unbindTargets();
    return out;
  }

  /** Upload RGBA float data into a texture. */
  upload(t: Tex, data: Float32Array): void {
    const gl = this.ctx.gl;
    const info = formatInfo(gl, t.format);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, t.width, t.height, info.format, info.type, data);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
}
