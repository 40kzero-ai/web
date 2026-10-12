import type { GLContext } from './context';
import type { Tex } from './texture';

export const FULLSCREEN_VS = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  // Fullscreen triangle from gl_VertexID.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export type UniformValue = number | boolean | number[] | Float32Array | Int32Array | Tex;

export class Program {
  readonly program: WebGLProgram;
  private uniforms = new Map<string, WebGLUniformLocation | null>();
  private types = new Map<string, number>();

  constructor(
    private ctx: GLContext,
    fragSource: string,
    vertSource: string = FULLSCREEN_VS,
    readonly name = 'program',
  ) {
    const gl = ctx.gl;
    const vs = compile(gl, gl.VERTEX_SHADER, vertSource, name + '.vert');
    const fs = compile(gl, gl.FRAGMENT_SHADER, fragSource, name + '.frag');
    const prog = gl.createProgram();
    if (!prog) throw new Error('createProgram failed');
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error(`Program link failed (${name}): ${log}`);
    }
    this.program = prog;
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(prog, i);
      if (!info) continue;
      const nm = info.name.replace(/\[0\]$/, '');
      this.uniforms.set(nm, gl.getUniformLocation(prog, info.name));
      this.types.set(nm, info.type);
    }
  }

  use(): void {
    this.ctx.gl.useProgram(this.program);
  }

  /** Set uniforms; textures are bound to sequential texture units. */
  set(values: Record<string, UniformValue>): void {
    const gl = this.ctx.gl;
    let unit = 0;
    for (const [name, v] of Object.entries(values)) {
      const loc = this.uniforms.get(name);
      if (loc === undefined) continue; // unused uniform optimized out
      const type = this.types.get(name)!;
      if (typeof v === 'object' && v !== null && 'tex' in v) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, (v as Tex).tex);
        gl.uniform1i(loc, unit);
        unit++;
      } else if (typeof v === 'boolean') {
        gl.uniform1i(loc, v ? 1 : 0);
      } else if (typeof v === 'number') {
        if (type === gl.INT || type === gl.UNSIGNED_INT || type === gl.BOOL || type === gl.SAMPLER_2D) gl.uniform1i(loc, v | 0);
        else gl.uniform1f(loc, v);
      } else {
        const arr = v as number[] | Float32Array | Int32Array;
        switch (type) {
          case gl.FLOAT_VEC2: gl.uniform2fv(loc, arr); break;
          case gl.FLOAT_VEC3: gl.uniform3fv(loc, arr); break;
          case gl.FLOAT_VEC4: gl.uniform4fv(loc, arr); break;
          case gl.INT_VEC2: gl.uniform2iv(loc, arr as Int32Array | number[]); break;
          case gl.FLOAT_MAT4: gl.uniformMatrix4fv(loc, false, arr); break;
          case gl.FLOAT_MAT3: gl.uniformMatrix3fv(loc, false, arr); break;
          case gl.FLOAT: gl.uniform1fv(loc, arr); break;
          case gl.INT: gl.uniform1iv(loc, arr as Int32Array | number[]); break;
          default: gl.uniform1fv(loc, arr);
        }
      }
    }
  }

  dispose(): void {
    this.ctx.gl.deleteProgram(this.program);
  }
}

function compile(gl: WebGL2RenderingContext, type: number, src: string, name: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('createShader failed');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    const numbered = src.split('\n').map((l, i) => `${String(i + 1).padStart(4)}: ${l}`).join('\n');
    console.error(`Shader compile failed (${name}):\n${log}\n${numbered}`);
    throw new Error(`Shader compile failed (${name}): ${log}`);
  }
  return sh;
}

/** Lazily-compiled program cache keyed by name. */
export class ProgramCache {
  private cache = new Map<string, Program>();
  constructor(private ctx: GLContext) {}
  get(name: string, build: () => string, vert?: string): Program {
    let p = this.cache.get(name);
    if (!p) {
      p = new Program(this.ctx, build(), vert, name);
      this.cache.set(name, p);
    }
    return p;
  }
}
