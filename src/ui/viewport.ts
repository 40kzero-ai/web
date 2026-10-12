import type { GLContext } from '../gl/context';
import type { Engine } from '../engine/engine';
import type { Tex } from '../gl/texture';
import { Program } from '../gl/program';
import { HEADER, SAMPLING } from '../shaders/common';

export interface ViewContent {
  /** Heightfield used for geometry / shading. */
  geometry: Tex | null;
  /** Optional grayscale mask painted over the terrain. */
  overlay: Tex | null;
  /** Optional RGBA color map. */
  color: Tex | null;
}

const VIEW2D_FS = `${HEADER}${SAMPLING}
uniform sampler2D uH; uniform sampler2D uColor; uniform sampler2D uOverlay;

// Soft ray-marched shadow and horizon-based ambient occlusion on the height field.
// uv in [0,1], h in [0,1]; uHs = height scale in texels. Sun direction in texel space.
vec2 shadowAO(sampler2D hm, vec2 uv, float h, vec3 sun, float hs) {
  ivec2 res = textureSize(hm, 0);
  vec2 texel = 1.0 / vec2(res);
  vec2 sdir = normalize(sun.xy + 1e-5);
  float slope = sun.z / max(length(sun.xy), 1e-4);  // rise per texel
  float shadow = 0.0;
  float t = 1.5;
  for (int i = 0; i < 28; i++) {
    vec2 p = uv + sdir * t * texel;
    if (p.x < 0.0 || p.y < 0.0 || p.x > 1.0 || p.y > 1.0) break;
    float hr = (sampleBilinear(hm, p).r - h) * hs;
    float occl = (hr - slope * t) / t;
    shadow = max(shadow, occl);
    t *= 1.22;
  }
  float sh = 1.0 - 0.8 * smoothstep(0.0, 0.45, shadow);
  // AO: average horizon elevation over 8 directions
  float ao = 0.0;
  for (int d = 0; d < 8; d++) {
    float a = float(d) * 0.785398;
    vec2 dir = vec2(cos(a), sin(a));
    float horizon = 0.0;
    float r = 2.0;
    for (int j = 0; j < 5; j++) {
      vec2 p = clamp(uv + dir * r * texel, 0.0, 1.0);
      float hr = (sampleBilinear(hm, p).r - h) * hs;
      horizon = max(horizon, hr / r);
      r *= 2.2;
    }
    ao += atan(horizon) / 1.5708;
  }
  ao = 1.0 - 0.75 * ao / 8.0;
  return vec2(sh, ao);
}

uniform int uMode;        // 0 clay, 1 color, 2 overlay
uniform float uHs; uniform vec3 uSun; uniform vec2 uOffset; uniform vec2 uSize; uniform vec2 uCanvas;
out vec4 o;
void main() {
  vec2 px = gl_FragCoord.xy;
  vec2 uv = (px - uOffset) / uSize;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { o = vec4(0.09, 0.09, 0.1, 1.0); return; }
  if (uMode == 2) { float m = sampleBilinear(uOverlay, uv).r; o = vec4(vec3(m), 1.0); return; }
  ivec2 res = textureSize(uH, 0);
  vec2 tp = uv * vec2(res);
  float e = max(1.0, float(res.x) / uSize.x);  // sample spacing in texels relative to screen pixels
  float l = sampleBilinearPx(uH, tp + vec2(-e, 0.0)).r, r = sampleBilinearPx(uH, tp + vec2(e, 0.0)).r;
  float d = sampleBilinearPx(uH, tp + vec2(0.0, -e)).r, u = sampleBilinearPx(uH, tp + vec2(0.0, e)).r;
  vec2 g = vec2(r - l, u - d) / (2.0 * e) * uHs;
  vec3 n = normalize(vec3(-g.x, -g.y, 1.0));
  float diff = max(dot(n, normalize(uSun)), 0.0);
  float h = sampleBilinearPx(uH, tp).r;
  vec2 sa = shadowAO(uH, uv, h, normalize(uSun), uHs);
  float amb = (0.38 + 0.17 * n.z) * sa.y;
  vec3 albedo;
  if (uMode == 1) albedo = sampleBilinear(uColor, uv).rgb;
  else albedo = mix(vec3(0.62, 0.60, 0.56), vec3(0.92, 0.91, 0.88), h);
  o = vec4(albedo * (diff * 0.9 * sa.x + amb), 1.0);
}`;

const TERRAIN_VS = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
${SAMPLING}
uniform sampler2D uH; uniform mat4 uViewProj; uniform ivec2 uGrid; uniform float uAspect; uniform float uHeightScale;
out vec2 vUv; out vec3 vWorld;
void main() {
  int ix = gl_VertexID % uGrid.x;
  int iy = gl_VertexID / uGrid.x;
  vec2 uv = vec2(float(ix) / float(uGrid.x - 1), float(iy) / float(uGrid.y - 1));
  float h = sampleBilinear(uH, uv).r;
  vec3 w = vec3((uv.x - 0.5) * uAspect, h * uHeightScale, 0.5 - uv.y);
  vUv = uv; vWorld = w;
  gl_Position = uViewProj * vec4(w, 1.0);
}`;

const TERRAIN_FS = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
${SAMPLING}
in vec2 vUv; in vec3 vWorld;
uniform sampler2D uH; uniform sampler2D uColor; uniform sampler2D uOverlay;
uniform int uMode; uniform float uHs; uniform vec3 uSun; uniform vec3 uCam; uniform vec3 uSky; uniform float uAspect;
out vec4 o;

// Soft ray-marched shadow and horizon-based ambient occlusion on the height field.
// uv in [0,1], h in [0,1]; uHs = height scale in texels. Sun direction in texel space.
vec2 shadowAO(sampler2D hm, vec2 uv, float h, vec3 sun, float hs) {
  ivec2 res = textureSize(hm, 0);
  vec2 texel = 1.0 / vec2(res);
  vec2 sdir = normalize(sun.xy + 1e-5);
  float slope = sun.z / max(length(sun.xy), 1e-4);  // rise per texel
  float shadow = 0.0;
  float t = 1.5;
  for (int i = 0; i < 28; i++) {
    vec2 p = uv + sdir * t * texel;
    if (p.x < 0.0 || p.y < 0.0 || p.x > 1.0 || p.y > 1.0) break;
    float hr = (sampleBilinear(hm, p).r - h) * hs;
    float occl = (hr - slope * t) / t;
    shadow = max(shadow, occl);
    t *= 1.22;
  }
  float sh = 1.0 - 0.8 * smoothstep(0.0, 0.45, shadow);
  // AO: average horizon elevation over 8 directions
  float ao = 0.0;
  for (int d = 0; d < 8; d++) {
    float a = float(d) * 0.785398;
    vec2 dir = vec2(cos(a), sin(a));
    float horizon = 0.0;
    float r = 2.0;
    for (int j = 0; j < 5; j++) {
      vec2 p = clamp(uv + dir * r * texel, 0.0, 1.0);
      float hr = (sampleBilinear(hm, p).r - h) * hs;
      horizon = max(horizon, hr / r);
      r *= 2.2;
    }
    ao += atan(horizon) / 1.5708;
  }
  ao = 1.0 - 0.75 * ao / 8.0;
  return vec2(sh, ao);
}

void main() {
  ivec2 res = textureSize(uH, 0);
  vec2 tp = vUv * vec2(res);
  float l = sampleBilinearPx(uH, tp + vec2(-1.0, 0.0)).r, r = sampleBilinearPx(uH, tp + vec2(1.0, 0.0)).r;
  float d = sampleBilinearPx(uH, tp + vec2(0.0, -1.0)).r, u = sampleBilinearPx(uH, tp + vec2(0.0, 1.0)).r;
  vec2 g = vec2(r - l, u - d) * 0.5 * uHs;
  vec3 n = normalize(vec3(-g.x, 1.0, g.y));
  float h = sampleBilinearPx(uH, tp).r;
  vec3 albedo;
  if (uMode == 1) albedo = sampleBilinear(uColor, vUv).rgb;
  else if (uMode == 2) { float m = sampleBilinear(uOverlay, vUv).r; albedo = mix(vec3(0.12, 0.13, 0.16), vec3(1.0, 0.98, 0.9), m); }
  else albedo = mix(vec3(0.60, 0.58, 0.54), vec3(0.93, 0.92, 0.89), h);
  vec3 sun = normalize(uSun);
  float diff = max(dot(n, sun), 0.0);
  // sun in texel space: world x -> u, world -z -> v
  vec2 sa = shadowAO(uH, vUv, h, normalize(vec3(sun.x, -sun.z, sun.y)), uHs);
  vec3 ambient = mix(vec3(0.26, 0.24, 0.22), uSky * 0.95, n.y * 0.5 + 0.5) * 0.8 * sa.y;
  vec3 v = normalize(uCam - vWorld);
  float spec = pow(max(dot(normalize(sun + v), n), 0.0), 24.0) * 0.08 * sa.x;
  vec3 col = albedo * (diff * vec3(1.0, 0.96, 0.9) * 1.1 * sa.x + ambient) + spec;
  // edge darkening outside map, fog by distance
  float dist = length(uCam - vWorld);
  float fog = 1.0 - exp(-dist * dist * 0.08 / (uAspect * uAspect));
  col = mix(col, uSky, clamp(fog, 0.0, 0.85));
  o = vec4(pow(col, vec3(1.0 / 1.05)), 1.0);
}`;

function perspective(fovy: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovy / 2);
  const out = new Float32Array(16);
  out[0] = f / aspect; out[5] = f; out[10] = (far + near) / (near - far); out[11] = -1; out[14] = (2 * far * near) / (near - far);
  return out;
}
function lookAt(eye: number[], target: number[], up: number[]): Float32Array {
  const z = norm([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
  const x = norm(cross(up, z));
  const y = cross(z, x);
  const out = new Float32Array(16);
  out[0] = x[0]; out[4] = x[1]; out[8] = x[2];
  out[1] = y[0]; out[5] = y[1]; out[9] = y[2];
  out[2] = z[0]; out[6] = z[1]; out[10] = z[2];
  out[12] = -dot(x, eye); out[13] = -dot(y, eye); out[14] = -dot(z, eye); out[15] = 1;
  return out;
}
function mul(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k];
    out[i * 4 + j] = s;
  }
  return out;
}
const norm = (v: number[]) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Renders the selected node's output in 2D (hillshade) or 3D (orbit camera) on the shared canvas. */
export class Viewport {
  mode: '2d' | '3d' = '3d';
  heightRatio = 0.22;
  private content: ViewContent = { geometry: null, overlay: null, color: null };
  private prog2d: Program;
  private prog3d: Program;
  private meshVao: WebGLVertexArrayObject;
  private meshIndexCount = 0;
  private grid: [number, number] = [2, 2];
  private cam = { yaw: 0.55, pitch: 0.62, dist: 2.3, target: [0, 0.03, 0] as number[] };
  private view2d = { zoom: 1, panX: 0, panY: 0 };
  private sun = [-0.6, 0.62, 0.45];
  private needsDraw = true;
  private dpr = Math.min(window.devicePixelRatio || 1, 2);

  constructor(private ctx: GLContext, private engine: Engine, private canvas: HTMLCanvasElement) {
    this.prog2d = new Program(ctx, VIEW2D_FS, undefined, 'view2d');
    this.prog3d = new Program(ctx, TERRAIN_FS, TERRAIN_VS, 'terrain3d');
    const gl = ctx.gl;
    const vao = gl.createVertexArray()!;
    this.meshVao = vao;
    this.bindInput();
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas);
    this.resize();
    const loop = () => { if (this.needsDraw) { this.needsDraw = false; this.draw(); } requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  private resize(): void {
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * this.dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
    this.needsDraw = true;
  }

  setContent(c: ViewContent): void {
    const pool = this.engine.pool;
    for (const t of [c.geometry, c.overlay, c.color]) if (t) pool.retain(t);
    for (const t of [this.content.geometry, this.content.overlay, this.content.color]) if (t) pool.release(t);
    this.content = { ...c };
    if (c.geometry) this.ensureMesh(c.geometry.width / c.geometry.height);
    this.needsDraw = true;
  }

  invalidate(): void { this.needsDraw = true; }

  resetCamera(): void {
    this.cam = { yaw: 0.55, pitch: 0.62, dist: 2.3, target: [0, 0.03, 0] };
    this.view2d = { zoom: 1, panX: 0, panY: 0 };
    this.needsDraw = true;
  }

  private ensureMesh(aspect: number): void {
    const gw = 1024;
    const gh = Math.max(2, Math.round(gw / aspect));
    if (this.grid[0] === gw && this.grid[1] === gh) return;
    const gl = this.ctx.gl;
    this.grid = [gw, gh];
    const idx = new Uint32Array((gw - 1) * (gh - 1) * 6);
    let k = 0;
    for (let y = 0; y < gh - 1; y++) for (let x = 0; x < gw - 1; x++) {
      const a = y * gw + x, b = a + 1, c = a + gw, d = c + 1;
      idx[k++] = a; idx[k++] = c; idx[k++] = b;
      idx[k++] = b; idx[k++] = c; idx[k++] = d;
    }
    gl.bindVertexArray(this.meshVao);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.meshIndexCount = idx.length;
  }

  private bindInput(): void {
    const c = this.canvas;
    let drag: { btn: number; x: number; y: number } | null = null;
    c.addEventListener('pointerdown', (e) => { drag = { btn: e.button, x: e.clientX, y: e.clientY }; c.setPointerCapture(e.pointerId); });
    c.addEventListener('pointerup', () => { drag = null; });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      if (this.mode === '3d') {
        if (drag.btn === 0 && !e.shiftKey) {
          this.cam.yaw -= dx * 0.006;
          this.cam.pitch = Math.min(1.5, Math.max(0.05, this.cam.pitch + dy * 0.006));
        } else {
          const s = this.cam.dist * 0.0012;
          const right = [Math.cos(this.cam.yaw), 0, -Math.sin(this.cam.yaw)];
          const fwd = [Math.sin(this.cam.yaw), 0, Math.cos(this.cam.yaw)];
          this.cam.target[0] -= (right[0] * dx - fwd[0] * dy) * s;
          this.cam.target[2] -= (right[2] * dx - fwd[2] * dy) * s;
        }
      } else {
        this.view2d.panX += dx * this.dpr; this.view2d.panY -= dy * this.dpr;
      }
      this.needsDraw = true;
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const f = Math.exp(e.deltaY * 0.001);
      if (this.mode === '3d') this.cam.dist = Math.min(8, Math.max(0.15, this.cam.dist * f));
      else this.view2d.zoom = Math.min(16, Math.max(0.2, this.view2d.zoom / f));
      this.needsDraw = true;
    }, { passive: false });
  }

  private draw(): void {
    const gl = this.ctx.gl;
    const W = this.canvas.width, H = this.canvas.height;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    const g = this.content.geometry;
    const mode = this.content.color ? 1 : this.content.overlay ? 2 : 0;
    if (!g) {
      gl.clearColor(0.09, 0.09, 0.1, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      return;
    }
    const hs = this.heightRatio * g.width;
    if (this.mode === '2d') {
      gl.disable(gl.DEPTH_TEST);
      const aspect = g.width / g.height;
      const fit = Math.min(W / aspect, H) * 0.96 * this.view2d.zoom;
      const size = [fit * aspect, fit];
      const off = [(W - size[0]) / 2 + this.view2d.panX, (H - size[1]) / 2 + this.view2d.panY];
      this.prog2d.use();
      this.prog2d.set({ uH: g, uColor: this.content.color ?? g, uOverlay: this.content.overlay ?? g, uMode: mode, uHs: hs, uSun: [this.sun[0], -this.sun[2], this.sun[1]], uOffset: off, uSize: size, uCanvas: [W, H], uRes: [W, H] });
      this.ctx.drawQuad();
      return;
    }
    const sky = [0.62, 0.72, 0.85];
    gl.clearColor(sky[0], sky[1], sky[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    const aspect = g.width / g.height;
    const { yaw, pitch, dist, target } = this.cam;
    const eye = [target[0] + Math.sin(yaw) * Math.cos(pitch) * dist, target[1] + Math.sin(pitch) * dist, target[2] + Math.cos(yaw) * Math.cos(pitch) * dist];
    const view = lookAt(eye, target, [0, 1, 0]);
    const proj = perspective(0.9, W / H, 0.01, 50);
    const vp = mul(proj, view);
    this.prog3d.use();
    this.prog3d.set({
      uH: g, uColor: this.content.color ?? g, uOverlay: this.content.overlay ?? g, uMode: mode, uHs: hs,
      uViewProj: vp, uGrid: new Int32Array(this.grid), uAspect: aspect, uHeightScale: this.heightRatio * aspect,
      uSun: this.sun, uCam: eye, uSky: sky,
    });
    gl.bindVertexArray(this.meshVao);
    gl.drawElements(gl.TRIANGLES, this.meshIndexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
    gl.disable(gl.DEPTH_TEST);
  }
}
