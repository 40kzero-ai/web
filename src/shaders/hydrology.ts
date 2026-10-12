import { HEADER, SAMPLING } from './common';

/** Depression filling (Planchon & Darboux, Jacobi form). W' = max(h, min_n(W_n) + eps); borders drain. */
export const FILL_INIT = `${HEADER}${SAMPLING}
uniform sampler2D uH; uniform sampler2D uPrev; uniform int uHasPrev;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float h = texelFetch(uH, p, 0).r;
  bool border = p.x == 0 || p.y == 0 || p.x == uRes.x - 1 || p.y == uRes.y - 1;
  float w = border ? h : 1e3;
  if (uHasPrev == 1 && !border) w = max(h, sampleBilinear(uPrev, vUv).r);
  o = vec4(w, 0.0, 0.0, 1.0);
}`;

export const FILL_ITER = `${HEADER}${SAMPLING}
uniform sampler2D uH; uniform sampler2D uW; uniform float uEps;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float h = texelFetch(uH, p, 0).r;
  bool border = p.x == 0 || p.y == 0 || p.x == uRes.x - 1 || p.y == uRes.y - 1;
  if (border) { o = vec4(h, 0.0, 0.0, 1.0); return; }
  float m = 1e3;
  for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
    if (dx == 0 && dy == 0) continue;
    float dist = (dx != 0 && dy != 0) ? 1.41421356 : 1.0;
    m = min(m, texelFetch(uW, p + ivec2(dx, dy), 0).r + uEps * dist);
  }
  o = vec4(max(h, m), 0.0, 0.0, 1.0);
}`;

/**
 * Multiple-flow-direction routing (Freeman / Quinn): each cell sends flow to every lower
 * neighbour in proportion to slope^p. This pass stores the per-cell weight sum so that the
 * accumulation pass can evaluate any neighbour's fraction with one extra read.
 * Output: r = sum of slope^p over lower neighbours (0 = sink), g = steepest slope.
 */
export const FLOW_DIR = `${HEADER}${SAMPLING}
uniform sampler2D uW; uniform float uExp;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float w = texelFetch(uW, p, 0).r;
  float sum = 0.0, best = 0.0;
  for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
    if (dx == 0 && dy == 0) continue;
    ivec2 q = p + ivec2(dx, dy);
    if (q.x < 0 || q.y < 0 || q.x >= uRes.x || q.y >= uRes.y) continue;
    float dist = (dx != 0 && dy != 0) ? 1.41421356 : 1.0;
    float s = (w - texelFetch(uW, q, 0).r) / dist;
    if (s > 0.0) { sum += pow(s, uExp); best = max(best, s); }
  }
  o = vec4(sum, best, 0.0, 1.0);
}`;

/** Accumulation Jacobi step with MFD partition: A' = 1 + sum_n A_n * slope(n->p)^p / sum_n. */
export const FLOW_ACC = `${HEADER}${SAMPLING}
uniform sampler2D uW; uniform sampler2D uDir; uniform sampler2D uA; uniform float uExp;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float wp = texelFetch(uW, p, 0).r;
  float acc = 1.0;
  for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
    if (dx == 0 && dy == 0) continue;
    ivec2 q = p + ivec2(dx, dy);
    if (q.x < 0 || q.y < 0 || q.x >= uRes.x || q.y >= uRes.y) continue;
    float dist = (dx != 0 && dy != 0) ? 1.41421356 : 1.0;
    float s = (texelFetch(uW, q, 0).r - wp) / dist;   // neighbour q is higher -> it drains into p
    if (s <= 0.0) continue;
    float sumq = texelFetch(uDir, q, 0).r;
    if (sumq <= 0.0) continue;
    acc += texelFetch(uA, q, 0).r * pow(s, uExp) / sumq;
  }
  o = vec4(acc, 0.0, 0.0, 1.0);
}`;

export const FLOW_INIT = `${HEADER}${SAMPLING}
uniform sampler2D uPrev; uniform int uHasPrev; uniform float uScale;
out vec4 o;
void main() {
  float a = uHasPrev == 1 ? max(sampleBilinear(uPrev, vUv).r * uScale, 1.0) : 1.0;
  o = vec4(a, 0.0, 0.0, 1.0);
}`;

/** Log-normalised flow and lake mask / depth from the fill surface. */
export const FLOW_FINISH = `${HEADER}${SAMPLING}
uniform sampler2D uA; uniform sampler2D uW; uniform sampler2D uH; uniform float uLogMax; uniform float uPower; uniform float uLakeMin;
layout(location = 0) out vec4 oFlow;
layout(location = 1) out vec4 oLake;
layout(location = 2) out vec4 oFilled;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float a = sampleBilinear(uA, vUv).r;
  float w = sampleBilinear(uW, vUv).r;
  float h = texelFetch(uH, p, 0).r;
  float f = pow(clamp(log(max(a, 1.0)) / uLogMax, 0.0, 1.0), uPower);
  float depth = max(w - h, 0.0);
  float lake = smoothstep(uLakeMin * 0.5, uLakeMin * 1.5, depth);
  // no channels across lake surfaces (D8 on a flat fill produces straight fans)
  f *= 1.0 - smoothstep(0.0, uLakeMin * 0.5, depth);
  oFlow = vec4(f, 0.0, 0.0, 1.0);
  oLake = vec4(lake, 0.0, 0.0, 1.0);
  oFilled = vec4(max(h, w), 0.0, 0.0, 1.0);
}`;
