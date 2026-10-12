/** WebGL2 context wrapper: extension checks, fullscreen draw, fences. */

export interface GLCaps {
  maxTextureSize: number;
  maxDrawBuffers: number;
  floatLinear: boolean;
  renderer: string;
}

export class GLContext {
  readonly gl: WebGL2RenderingContext;
  readonly canvas: HTMLCanvasElement;
  readonly caps: GLCaps;
  private quadVao: WebGLVertexArrayObject;

  constructor(canvas?: HTMLCanvasElement) {
    this.canvas = canvas ?? document.createElement('canvas');
    const gl = this.canvas.getContext('webgl2', {
      antialias: false,
      depth: true,
      stencil: false,
      alpha: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not supported by this browser.');
    this.gl = gl;
    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new Error('EXT_color_buffer_float is required (float render targets).');
    }
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.caps = {
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxDrawBuffers: gl.getParameter(gl.MAX_DRAW_BUFFERS),
      floatLinear: !!gl.getExtension('OES_texture_float_linear'),
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    };
    // Fullscreen triangle VAO (no attributes needed; positions derived from gl_VertexID).
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('Failed to create VAO');
    this.quadVao = vao;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
  }

  /** Draw a single fullscreen triangle. */
  drawQuad(): void {
    const gl = this.gl;
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  /** Resolve when all previously issued GPU commands have completed (non-blocking poll). */
  sync(): Promise<void> {
    const gl = this.gl;
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!fence) {
      gl.finish();
      return Promise.resolve();
    }
    gl.flush();
    return new Promise((resolve) => {
      const poll = () => {
        const res = gl.clientWaitSync(fence, 0, 0);
        if (res === gl.ALREADY_SIGNALED || res === gl.CONDITION_SATISFIED || res === gl.WAIT_FAILED) {
          gl.deleteSync(fence);
          resolve();
        } else {
          setTimeout(poll, 2);
        }
      };
      poll();
    });
  }

  checkError(where: string): void {
    const err = this.gl.getError();
    if (err !== this.gl.NO_ERROR) {
      console.warn(`WebGL error ${err.toString(16)} at ${where}`);
    }
  }
}
