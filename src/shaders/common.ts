/** Shared GLSL fragments. All compute shaders render into float textures via a fullscreen triangle. */

export const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 vUv;
uniform ivec2 uRes;      // output resolution
`;

/** Clamped texel fetch + manual bilinear sampling (float textures use NEAREST filtering). */
export const SAMPLING = `
ivec2 clampCoord(ivec2 p, ivec2 res) { return clamp(p, ivec2(0), res - 1); }

vec4 fetchC(sampler2D t, ivec2 p) {
  ivec2 r = textureSize(t, 0);
  return texelFetch(t, clamp(p, ivec2(0), r - 1), 0);
}

// Bilinear sample at continuous pixel coordinate (pixel centers at integer + 0.5).
vec4 sampleBilinearPx(sampler2D t, vec2 px) {
  ivec2 r = textureSize(t, 0);
  vec2 p = px - 0.5;
  vec2 f = fract(p);
  ivec2 i = ivec2(floor(p));
  vec4 a = texelFetch(t, clamp(i, ivec2(0), r - 1), 0);
  vec4 b = texelFetch(t, clamp(i + ivec2(1, 0), ivec2(0), r - 1), 0);
  vec4 c = texelFetch(t, clamp(i + ivec2(0, 1), ivec2(0), r - 1), 0);
  vec4 d = texelFetch(t, clamp(i + ivec2(1, 1), ivec2(0), r - 1), 0);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// Bilinear sample at normalized uv in [0,1], resolution independent.
vec4 sampleBilinear(sampler2D t, vec2 uv) {
  vec2 r = vec2(textureSize(t, 0));
  return sampleBilinearPx(t, uv * r);
}

// Bicubic (Catmull-Rom) sample at normalized uv for smooth upsampling.
vec4 sampleBicubic(sampler2D t, vec2 uv) {
  ivec2 ri = textureSize(t, 0);
  vec2 r = vec2(ri);
  vec2 p = uv * r - 0.5;
  vec2 f = fract(p);
  ivec2 i = ivec2(floor(p));
  vec2 f2 = f * f, f3 = f2 * f;
  vec2 w0 = -0.5 * f3 + f2 - 0.5 * f;
  vec2 w1 = 1.5 * f3 - 2.5 * f2 + 1.0;
  vec2 w2 = -1.5 * f3 + 2.0 * f2 + 0.5 * f;
  vec2 w3 = 0.5 * f3 - 0.5 * f2;
  vec4 acc = vec4(0.0);
  float wx[4]; wx[0] = w0.x; wx[1] = w1.x; wx[2] = w2.x; wx[3] = w3.x;
  float wy[4]; wy[0] = w0.y; wy[1] = w1.y; wy[2] = w2.y; wy[3] = w3.y;
  for (int y = 0; y < 4; y++) {
    vec4 row = vec4(0.0);
    for (int x = 0; x < 4; x++) {
      row += wx[x] * texelFetch(t, clamp(i + ivec2(x - 1, y - 1), ivec2(0), ri - 1), 0);
    }
    acc += wy[y] * row;
  }
  return acc;
}
`;

/** Integer hashing + gradient / value / cellular noise (seedable, precision safe). */
export const NOISE = `
uint pcg(uint v) {
  uint state = v * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
uint hash2u(ivec2 p, uint seed) {
  return pcg(uint(p.x) + pcg(uint(p.y) + pcg(seed)));
}
float hash2f(ivec2 p, uint seed) { return float(hash2u(p, seed)) * (1.0 / 4294967296.0); }
vec2 hash2v(ivec2 p, uint seed) {
  uint h = hash2u(p, seed);
  return vec2(float(h & 0xffffu), float(h >> 16u)) * (1.0 / 65535.0);
}
vec2 gradDir(ivec2 p, uint seed) {
  float a = hash2f(p, seed) * 6.28318530718;
  return vec2(cos(a), sin(a));
}

// Perlin gradient noise, output roughly in [-1, 1].
float perlin(vec2 x, uint seed) {
  vec2 i = floor(x);
  vec2 f = x - i;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  ivec2 ii = ivec2(i);
  float a = dot(gradDir(ii, seed), f);
  float b = dot(gradDir(ii + ivec2(1, 0), seed), f - vec2(1.0, 0.0));
  float c = dot(gradDir(ii + ivec2(0, 1), seed), f - vec2(0.0, 1.0));
  float d = dot(gradDir(ii + ivec2(1, 1), seed), f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 1.4142;
}

// Perlin noise with analytic derivative: returns (value, d/dx, d/dy).
vec3 perlinD(vec2 x, uint seed) {
  vec2 i = floor(x);
  vec2 f = x - i;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  ivec2 ii = ivec2(i);
  vec2 ga = gradDir(ii, seed), gb = gradDir(ii + ivec2(1, 0), seed), gc = gradDir(ii + ivec2(0, 1), seed), gd = gradDir(ii + ivec2(1, 1), seed);
  float va = dot(ga, f), vb = dot(gb, f - vec2(1.0, 0.0)), vc = dot(gc, f - vec2(0.0, 1.0)), vd = dot(gd, f - vec2(1.0, 1.0));
  float k = va - vb - vc + vd;
  float v = va + u.x * (vb - va) + u.y * (vc - va) + u.x * u.y * k;
  vec2 d = ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd) + du * (vec2(vb - va, vc - va) + u.yx * k);
  return vec3(v, d) * 1.4142;
}

float valueNoise(vec2 x, uint seed) {
  vec2 i = floor(x);
  vec2 f = x - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  ivec2 ii = ivec2(i);
  float a = hash2f(ii, seed);
  float b = hash2f(ii + ivec2(1, 0), seed);
  float c = hash2f(ii + ivec2(0, 1), seed);
  float d = hash2f(ii + ivec2(1, 1), seed);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 2.0 - 1.0;
}

// Cellular noise: returns (F1, F2, cell id hash, edge distance)
vec4 cellular(vec2 x, float jitter, uint seed) {
  vec2 i = floor(x);
  vec2 f = x - i;
  float f1 = 8.0, f2 = 8.0;
  float id = 0.0;
  vec2 bestPt = vec2(0.0);
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      ivec2 c = ivec2(i) + ivec2(dx, dy);
      vec2 o = hash2v(c, seed) * jitter + (1.0 - jitter) * 0.5;
      vec2 pt = vec2(dx, dy) + o - f;
      float d = dot(pt, pt);
      if (d < f1) { f2 = f1; f1 = d; id = hash2f(c, seed + 7u); bestPt = pt; }
      else if (d < f2) { f2 = d; }
    }
  }
  // Edge distance (Voronoi border) second pass
  float ed = 8.0;
  for (int dy = -2; dy <= 2; dy++) {
    for (int dx = -2; dx <= 2; dx++) {
      ivec2 c = ivec2(i) + ivec2(dx, dy);
      vec2 o = hash2v(c, seed) * jitter + (1.0 - jitter) * 0.5;
      vec2 pt = vec2(dx, dy) + o - f;
      vec2 diff = pt - bestPt;
      if (dot(diff, diff) > 1e-6) {
        ed = min(ed, dot(0.5 * (bestPt + pt), normalize(diff)));
      }
    }
  }
  return vec4(sqrt(f1), sqrt(f2), id, ed);
}

// Fractal Brownian motion of perlin noise; returns [-1,1]-ish normalized by amplitude sum.
float fbm(vec2 p, int octaves, float lacunarity, float gain, uint seed) {
  float sum = 0.0, amp = 1.0, norm = 0.0;
  for (int o = 0; o < 16; o++) {
    if (o >= octaves) break;
    sum += amp * perlin(p, seed + uint(o) * 131u);
    norm += amp;
    amp *= gain;
    p = p * lacunarity + vec2(17.3, 9.1);
  }
  return sum / max(norm, 1e-6);
}

// Domain warp vector from two independent fbm fields.
vec2 warpVec(vec2 p, int octaves, uint seed) {
  return vec2(fbm(p, octaves, 2.0, 0.5, seed + 101u), fbm(p + vec2(31.7, 11.3), octaves, 2.0, 0.5, seed + 202u));
}
`;

/** Height-field helpers (gradient, slope) given a scalar texture + vertical scale in cells. */
export const TERRAIN = `
// Gradient of height field in cell units (height scaled by hs).
vec2 heightGradient(sampler2D h, ivec2 p, float hs) {
  float l = fetchC(h, p + ivec2(-1, 0)).r;
  float r = fetchC(h, p + ivec2(1, 0)).r;
  float d = fetchC(h, p + ivec2(0, -1)).r;
  float u = fetchC(h, p + ivec2(0, 1)).r;
  return vec2(r - l, u - d) * 0.5 * hs;
}
vec3 heightNormal(sampler2D h, ivec2 p, float hs) {
  vec2 g = heightGradient(h, p, hs);
  return normalize(vec3(-g.x, -g.y, 1.0));
}
`;
