import { HEADER, SAMPLING, NOISE } from './common';

/**
 * Particle (droplet) hydraulic erosion. Each droplet walks downhill over the height field,
 * picks up sediment where it accelerates and drops it where it slows, with a brush-shaped
 * footprint. Deltas are splatted additively into a per-step texture and then applied.
 *
 * P0: pos.xy, dir.xy        P1: speed, water, sediment, amount (+erode / -deposit, cell units)
 * P2: splat pos.xy, active, kind (1 erode, 0 deposit)
 */
export const DROP_INIT = `${HEADER}${SAMPLING}${NOISE}
uniform int uSeed; uniform vec2 uSimRes;
layout(location = 0) out vec4 o0; layout(location = 1) out vec4 o1; layout(location = 2) out vec4 o2;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 r = hash2v(p, uint(uSeed));
  vec2 r2 = hash2v(p + ivec2(911, 0), uint(uSeed) + 17u);
  vec2 pos = vec2(r.x * (uSimRes.x - 2.0) + 1.0, r.y * (uSimRes.y - 2.0) + 1.0);
  float a = r2.x * 6.2831853;
  o0 = vec4(pos, cos(a) * 0.01, sin(a) * 0.01);
  o1 = vec4(1.0, 1.0, 0.0, 0.0);
  o2 = vec4(pos, 1.0, 0.0);
}`;

export const DROP_UPDATE = `${HEADER}${SAMPLING}
uniform sampler2D uP0; uniform sampler2D uP1; uniform sampler2D uP2; uniform sampler2D uH; uniform sampler2D uMask; uniform int uHasMask;
uniform sampler2D uDens;   // previous step's splat: g = local droplet density
uniform vec2 uSimRes; uniform float uHs;
uniform float uInertia; uniform float uCapacity; uniform float uDeposit; uniform float uErode; uniform float uEvap; uniform float uGravity; uniform float uMinSlope;
layout(location = 0) out vec4 o0; layout(location = 1) out vec4 o1; layout(location = 2) out vec4 o2;
// height (cell units) and gradient at continuous pixel position
vec3 heightGrad(vec2 px) {
  vec2 p = px - 0.5;
  vec2 f = fract(p);
  ivec2 i = ivec2(floor(p));
  ivec2 r = textureSize(uH, 0);
  float a = texelFetch(uH, clamp(i, ivec2(0), r - 1), 0).r;
  float b = texelFetch(uH, clamp(i + ivec2(1, 0), ivec2(0), r - 1), 0).r;
  float c = texelFetch(uH, clamp(i + ivec2(0, 1), ivec2(0), r - 1), 0).r;
  float d = texelFetch(uH, clamp(i + ivec2(1, 1), ivec2(0), r - 1), 0).r;
  float h = mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  vec2 g = vec2(mix(b - a, d - c, f.y), mix(c - a, d - b, f.x));
  return vec3(h, g) * uHs;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 s0 = texelFetch(uP0, p, 0);
  vec4 s1 = texelFetch(uP1, p, 0);
  vec4 s2 = texelFetch(uP2, p, 0);
  vec2 pos = s0.xy, dir = s0.zw;
  float speed = s1.x, water = s1.y, sed = s1.z;
  float alive = s2.z;
  if (alive < 0.5) { o0 = s0; o1 = vec4(s1.xyz, 0.0); o2 = vec4(s2.xy, 0.0, 0.0); return; }
  vec3 hg = heightGrad(pos);
  dir = dir * uInertia - hg.yz * (1.0 - uInertia);
  float dl = length(dir);
  if (dl < 1e-6) {
    // flat spot: nudge randomly so the droplet does not stall
    float a = fract(sin(dot(pos, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831853;
    dir = vec2(cos(a), sin(a));
  } else dir /= dl;
  vec2 npos = pos + dir;
  if (npos.x < 1.0 || npos.y < 1.0 || npos.x > uSimRes.x - 2.0 || npos.y > uSimRes.y - 2.0) {
    o0 = vec4(npos, dir); o1 = vec4(speed, water, sed, 0.0); o2 = vec4(pos, 0.0, 0.0); return;
  }
  float nh = heightGrad(npos).x;
  float dh = nh - hg.x;                    // > 0 uphill
  float m = uHasMask == 1 ? sampleBilinearPx(uMask, pos).r : 1.0;
  // Droplets in a batch share one height snapshot. Dividing by the local droplet density
  // (from the previous step) makes the per-cell change per step about one droplet's worth,
  // which restores the negative feedback a sequential simulation has.
  float dens = max(1.0, sampleBilinearPx(uDens, pos).g);
  float cap = max(-dh, uMinSlope) * speed * water * uCapacity;
  float amount = 0.0; float kind = 0.0;
  if (sed > cap || dh > 0.0) {
    float dep = dh > 0.0 ? min(dh, sed) : (sed - cap) * uDeposit;
    dep /= dens;
    sed -= dep; amount = -dep; kind = 0.0;
  } else {
    float er = min((cap - sed) * uErode * m, -dh * 0.5) / dens;
    sed += er; amount = er; kind = 1.0;
  }
  speed = min(sqrt(max(speed * speed - dh * uGravity * 0.1, 0.0)), 4.0);
  water *= (1.0 - uEvap);
  o0 = vec4(npos, dir);
  o1 = vec4(speed, water, sed, amount);
  o2 = vec4(pos, 1.0, kind);
}`;

export const DROP_SPLAT_VS = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
uniform sampler2D uP1; uniform sampler2D uP2; uniform ivec2 uPRes; uniform vec2 uSimRes; uniform float uRadius;
out float vAmount; out float vRadius; out float vWater; out float vSize;
void main() {
  ivec2 t = ivec2(gl_VertexID % uPRes.x, gl_VertexID / uPRes.x);
  vec4 s1 = texelFetch(uP1, t, 0);
  vec4 s2 = texelFetch(uP2, t, 0);
  if (s2.z < 0.5 || s1.w == 0.0) { gl_Position = vec4(-10.0, -10.0, 0.0, 1.0); gl_PointSize = 1.0; vAmount = 0.0; vRadius = 1.0; vWater = 0.0; vSize = 1.0; return; }
  float r = s2.w > 0.5 ? uRadius : 1.0;
  vRadius = r;
  vSize = 2.0 * r + 1.0;
  gl_PointSize = vSize;
  vAmount = s1.w;
  vWater = s1.y;
  gl_Position = vec4(s2.xy / uSimRes * 2.0 - 1.0, 0.0, 1.0);
}`;

export const DROP_SPLAT_FS = `#version 300 es
precision highp float;
in float vAmount; in float vRadius; in float vWater; in float vSize;
out vec4 o;
void main() {
  vec2 d = (gl_PointCoord - 0.5) * vSize;
  float r2 = dot(d, d) / (vRadius * vRadius);
  if (r2 > 1.0) discard;
  float w = (1.0 - r2);
  w /= (3.14159 * vRadius * vRadius * 0.5);   // integral of (1 - r^2) over the disc
  float a = vAmount * w;
  // r: height change (negative = removed), g: droplet density / flow, b: deposit, a: wear
  o = vec4(-a, (1.0 - r2) * vWater, max(-a, 0.0), max(a, 0.0));
}`;

export const DROP_APPLY = `${HEADER}
uniform sampler2D uH; uniform sampler2D uDelta; uniform sampler2D uMaps; uniform float uInvHs;
layout(location = 0) out vec4 oH; layout(location = 1) out vec4 oMaps;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float h = texelFetch(uH, p, 0).r;
  vec4 d = texelFetch(uDelta, p, 0);
  oH = vec4(h + d.r * uInvHs, 0.0, 0.0, 1.0);
  oMaps = texelFetch(uMaps, p, 0) + vec4(d.a, d.b, d.g, 0.0);
}`;
