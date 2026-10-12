import { HEADER, SAMPLING } from './common';

/**
 * Hydraulic erosion (virtual pipes model, Mei et al. 2007 with the depth-limited capacity of
 * Jákó & Tóth) in three fullscreen passes per iteration.
 *
 * state: r = terrain height B (cell units), g = water depth d, b = suspended sediment s, a = erodibility
 * flux:  outflow to L, R, B(down), T(up)
 * vel:   rg = water velocity (cells / iteration)
 * maps:  r = cumulative wear (erosion), g = cumulative deposition, b = cumulative discharge (flow)
 */

export const PACK_STATE = `${HEADER}${SAMPLING}
uniform sampler2D uBase;     // base height [0,1] at this level
uniform sampler2D uDelta;    // previous-level height delta [0,1] units (or empty)
uniform sampler2D uPrev;     // previous-level state (for water / sediment carry-over)
uniform sampler2D uMask;     // erodibility mask
uniform int uHasDelta; uniform int uHasPrev; uniform int uHasMask;
uniform float uHs;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float b = texelFetch(uBase, p, 0).r;
  if (uHasDelta == 1) b += sampleBicubic(uDelta, vUv).r;
  vec2 ds = vec2(0.0);
  if (uHasPrev == 1) ds = max(sampleBilinear(uPrev, vUv).gb, vec2(0.0));
  float m = uHasMask == 1 ? clamp(sampleBilinear(uMask, vUv).r, 0.0, 1.0) : 1.0;
  o = vec4(b * uHs, ds.x, ds.y, m);
}`;

export const FLUX_PASS = `${HEADER}${SAMPLING}
uniform sampler2D uState; uniform sampler2D uFlux;
uniform float uPipe;      // dt * A * g / l
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 st = texelFetch(uState, p, 0);
  float H = st.r + st.g;
  vec4 f = texelFetch(uFlux, p, 0);
  ivec2 offs[4]; offs[0] = ivec2(-1, 0); offs[1] = ivec2(1, 0); offs[2] = ivec2(0, -1); offs[3] = ivec2(0, 1);
  vec4 nf;
  for (int i = 0; i < 4; i++) {
    ivec2 q = p + offs[i];
    float Hn;
    if (q.x < 0 || q.y < 0 || q.x >= uRes.x || q.y >= uRes.y) {
      Hn = st.r;  // open boundary: neighbour has same terrain height and no water -> drains
    } else {
      vec4 n = texelFetch(uState, q, 0);
      Hn = n.r + n.g;
    }
    nf[i] = max(0.0, f[i] + uPipe * (H - Hn));
  }
  float sum = nf.x + nf.y + nf.z + nf.w;
  float K = sum > 1e-6 ? min(1.0, st.g / sum) : 0.0;
  o = nf * K;
}`;

export const WATER_EROSION_PASS = `${HEADER}${SAMPLING}
uniform sampler2D uState; uniform sampler2D uFlux; uniform sampler2D uMaps;
uniform float uKc;        // sediment capacity
uniform float uKs;        // erosion (rock softness)
uniform float uKd;        // deposition rate
uniform float uDepthMax;  // capacity fades out in water deeper than this
uniform float uMinSlope;
uniform float uThermal;   // talus slippage rate (0 disables)
uniform float uTalus;     // tan(talus angle)
uniform float uVmax;
layout(location = 0) out vec4 oState;
layout(location = 1) out vec4 oVel;
layout(location = 2) out vec4 oMaps;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 st = texelFetch(uState, p, 0);
  vec4 f = texelFetch(uFlux, p, 0);
  bool lOk = p.x > 0, rOk = p.x < uRes.x - 1, bOk = p.y > 0, tOk = p.y < uRes.y - 1;
  float inL = lOk ? texelFetch(uFlux, p + ivec2(-1, 0), 0).y : 0.0;  // left neighbour's rightward flux
  float inR = rOk ? texelFetch(uFlux, p + ivec2(1, 0), 0).x : 0.0;
  float inB = bOk ? texelFetch(uFlux, p + ivec2(0, -1), 0).w : 0.0;
  float inT = tOk ? texelFetch(uFlux, p + ivec2(0, 1), 0).z : 0.0;
  float outSum = f.x + f.y + f.z + f.w;
  float d0 = st.g;
  float d1 = max(0.0, d0 + (inL + inR + inB + inT) - outSum);
  float dMean = max(0.5 * (d0 + d1), 1e-4);
  vec2 v = vec2((inL - f.x + f.y - inR) * 0.5, (inB - f.z + f.w - inT) * 0.5) / dMean;
  float vl = length(v);
  if (vl > uVmax) v *= uVmax / vl;
  vl = min(vl, uVmax);

  // terrain slope (cell units)
  float B = st.r;
  float bl = fetchC(uState, p + ivec2(-1, 0)).r, br = fetchC(uState, p + ivec2(1, 0)).r;
  float bb = fetchC(uState, p + ivec2(0, -1)).r, bt = fetchC(uState, p + ivec2(0, 1)).r;
  vec2 g = vec2(br - bl, bt - bb) * 0.5;
  float sinA = length(g) / sqrt(1.0 + dot(g, g));
  float lmax = 1.0 - smoothstep(0.0, uDepthMax, d1);
  float depthGate = smoothstep(0.0, 0.02, d1);
  float C = uKc * max(sinA, uMinSlope) * vl * lmax * depthGate;

  float s = st.b;
  vec4 maps = texelFetch(uMaps, p, 0);
  float erod = st.a;
  if (C > s) {
    float dl = uKs * erod * (C - s);
    B -= dl; s += dl; maps.r += dl;
  } else {
    float dl = uKd * (s - C);
    B += dl; s -= dl; maps.g += dl;
  }
  maps.b += vl * d1;

  // thermal weathering (symmetric, mass conserving; uses pre-pass heights)
  if (uThermal > 0.0) {
    float b0 = st.r;
    float net = 0.0;
    for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
      if (dx == 0 && dy == 0) continue;
      ivec2 q = p + ivec2(dx, dy);
      if (q.x < 0 || q.y < 0 || q.x >= uRes.x || q.y >= uRes.y) continue;
      float bn = texelFetch(uState, q, 0).r;
      float dist = (dx != 0 && dy != 0) ? 1.41421356 : 1.0;
      float lim = uTalus * dist;
      float diff = b0 - bn;
      if (diff > lim) net -= (diff - lim) * 0.125 * uThermal * erod;
      else if (-diff > lim) net += (-diff - lim) * 0.125 * uThermal * texelFetch(uState, q, 0).a;
    }
    B += net;
  }

  oState = vec4(B, d1, s, st.a);
  oVel = vec4(v, 0.0, 1.0);
  oMaps = maps;
}`;

export const ADVECT_PASS = `${HEADER}${SAMPLING}
uniform sampler2D uState; uniform sampler2D uVel;
uniform float uEvap; uniform float uRain;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 st = texelFetch(uState, p, 0);
  vec2 v = texelFetch(uVel, p, 0).xy;
  vec2 src = vec2(p) + 0.5 - v;
  float s = sampleBilinearPx(uState, src).b;
  float d = st.g * (1.0 - uEvap) + uRain;
  o = vec4(st.r, d, max(s, 0.0), st.a);
}`;

/** Extract height delta in [0,1] units: (B/hs) - base. */
export const UNPACK_DELTA = `${HEADER}
uniform sampler2D uState; uniform sampler2D uBase; uniform float uInvHs;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  o = vec4(texelFetch(uState, p, 0).r * uInvHs - texelFetch(uBase, p, 0).r, 0.0, 0.0, 1.0);
}`;

/** Final height = base + bicubic(delta). */
export const APPLY_DELTA = `${HEADER}${SAMPLING}
uniform sampler2D uBase; uniform sampler2D uDelta; uniform int uSameRes;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float d = uSameRes == 1 ? texelFetch(uDelta, p, 0).r : sampleBicubic(uDelta, vUv).r;
  o = vec4(texelFetch(uBase, p, 0).r + d, 0.0, 0.0, 1.0);
}`;

/** Pull one channel of a map texture, resampled to the output size, with a power curve. */
export const EXTRACT_CHANNEL = `${HEADER}${SAMPLING}
uniform sampler2D uSrc; uniform int uChannel; uniform float uScale; uniform float uPower; uniform int uRaw;
out vec4 o;
void main() {
  vec4 v = uRaw == 1 ? texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0) : sampleBilinear(uSrc, vUv);
  float c = uChannel == 0 ? v.r : uChannel == 1 ? v.g : uChannel == 2 ? v.b : v.a;
  if (uRaw == 1) { o = vec4(max(c, 0.0), 0.0, 0.0, 1.0); return; }
  o = vec4(pow(clamp(c * uScale, 0.0, 1.0), uPower), 0.0, 0.0, 1.0);
}`;

/** Standalone thermal erosion pass on an R32F height (cell units via uHs). */
export const THERMAL_PASS = `${HEADER}${SAMPLING}
uniform sampler2D uH; uniform sampler2D uMask; uniform int uHasMask;
uniform float uHs; uniform float uRate; uniform float uTalus;
out vec4 o;
float m(ivec2 q) { return uHasMask == 1 ? fetchC(uMask, q).r : 1.0; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float b0 = texelFetch(uH, p, 0).r * uHs;
  float m0 = m(p);
  float net = 0.0;
  for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
    if (dx == 0 && dy == 0) continue;
    ivec2 q = p + ivec2(dx, dy);
    if (q.x < 0 || q.y < 0 || q.x >= uRes.x || q.y >= uRes.y) continue;
    float bn = texelFetch(uH, q, 0).r * uHs;
    float dist = (dx != 0 && dy != 0) ? 1.41421356 : 1.0;
    float lim = uTalus * dist;
    float diff = b0 - bn;
    if (diff > lim) net -= (diff - lim) * 0.125 * uRate * m0;
    else if (-diff > lim) net += (-diff - lim) * 0.125 * uRate * m(q);
  }
  o = vec4((b0 + net) / uHs, 0.0, 0.0, 1.0);
}`;
