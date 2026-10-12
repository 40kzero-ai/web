import { HEADER, SAMPLING, TERRAIN } from '../../shaders/common';
import type { NodeDef } from '../types';
import { blur } from './modifiers';

const IN_OUT = { inputs: [{ key: 'height', label: 'In', kind: 'height' as const }], outputs: [{ key: 'height', label: 'Out', kind: 'height' as const, isMask: true }] };

export const SlopeNode: NodeDef = {
  type: 'slope',
  title: 'Slope',
  category: 'Data',
  description: 'Mask from terrain steepness. Select an angle range; soft falloff.',
  ...IN_OUT,
  params: [
    { key: 'minAngle', label: 'Min angle', type: 'float', default: 20, min: 0, max: 90, step: 1 },
    { key: 'maxAngle', label: 'Max angle', type: 'float', default: 90, min: 0, max: 90, step: 1 },
    { key: 'falloff', label: 'Falloff', type: 'float', default: 10, min: 0, max: 45, step: 0.5 },
    { key: 'smooth', label: 'Pre-smooth', type: 'float', default: 0.001, min: 0, max: 0.02, step: 0.0005 },
  ],
  evaluate(engine, inputs, p, o) {
    const src = inputs.height;
    if (!src) throw new Error('Slope: input not connected');
    const smoothed = blur(engine, src, Number(p.smooth));
    const out = engine.alloc(o.width, o.height, 'R32F');
    engine.run('slope', () => `${HEADER}${SAMPLING}${TERRAIN}
uniform sampler2D uSrc; uniform float uHs; uniform vec2 uRange; uniform float uFalloff; out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 g = heightGradient(uSrc, p, uHs);
  float ang = degrees(atan(length(g)));
  float lo = smoothstep(uRange.x - uFalloff, uRange.x + 0.001, ang);
  float hi = 1.0 - smoothstep(uRange.y - 0.001, uRange.y + uFalloff, ang);
  o = vec4(lo * hi, 0.0, 0.0, 1.0);
}`, { uSrc: smoothed, uHs: o.heightRatio * o.width, uRange: [Number(p.minAngle), Number(p.maxAngle)], uFalloff: Math.max(Number(p.falloff), 0.001) }, out);
    engine.release(smoothed);
    return { height: out };
  },
};

export const HeightMaskNode: NodeDef = {
  type: 'heightmask',
  title: 'Height',
  category: 'Data',
  description: 'Mask selecting an altitude band with soft edges.',
  ...IN_OUT,
  params: [
    { key: 'low', label: 'From', type: 'float', default: 0.5, min: 0, max: 1, step: 0.005 },
    { key: 'high', label: 'To', type: 'float', default: 1, min: 0, max: 1, step: 0.005 },
    { key: 'falloff', label: 'Falloff', type: 'float', default: 0.1, min: 0, max: 0.5, step: 0.005 },
  ],
  evaluate(engine, inputs, p, o) {
    const src = inputs.height;
    if (!src) throw new Error('Height: input not connected');
    const out = engine.alloc(o.width, o.height, 'R32F');
    engine.run('heightmask', () => `${HEADER}
uniform sampler2D uSrc; uniform vec2 uRange; uniform float uFalloff; out vec4 o;
void main() {
  float h = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0).r;
  float f = max(uFalloff, 1e-4);
  float lo = smoothstep(uRange.x - f, uRange.x, h);
  float hi = 1.0 - smoothstep(uRange.y, uRange.y + f, h);
  o = vec4(lo * hi, 0.0, 0.0, 1.0);
}`, { uSrc: src, uRange: [Number(p.low), Number(p.high)], uFalloff: Number(p.falloff) }, out);
    return { height: out };
  },
};

export const CurvatureNode: NodeDef = {
  type: 'curvature',
  title: 'Curvature',
  category: 'Data',
  description: 'Convex (ridges) or concave (valleys) areas as a mask.',
  ...IN_OUT,
  params: [
    { key: 'mode', label: 'Mode', type: 'select', default: 'concave', options: [{ value: 'concave', label: 'Concave (valleys)' }, { value: 'convex', label: 'Convex (ridges)' }, { value: 'both', label: 'Both (signed)' }] },
    { key: 'radius', label: 'Radius', type: 'float', default: 0.003, min: 0.0005, max: 0.03, step: 0.0005 },
    { key: 'intensity', label: 'Intensity', type: 'float', default: 1, min: 0.1, max: 10, step: 0.1 },
  ],
  evaluate(engine, inputs, p, o) {
    const src = inputs.height;
    if (!src) throw new Error('Curvature: input not connected');
    // Curvature at scale r = blurred(h) - h (difference of gaussians), robust at any resolution.
    const smoothed = blur(engine, src, Number(p.radius));
    const out = engine.alloc(o.width, o.height, 'R32F');
    const mode = p.mode === 'convex' ? 1 : p.mode === 'both' ? 2 : 0;
    engine.run('curvature', () => `${HEADER}
uniform sampler2D uSrc; uniform sampler2D uBlur; uniform int uMode; uniform float uIntensity; uniform float uScale; out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float c = (texelFetch(uBlur, p, 0).r - texelFetch(uSrc, p, 0).r) * uScale * uIntensity;
  float r = uMode == 0 ? max(c, 0.0) : uMode == 1 ? max(-c, 0.0) : c * 0.5 + 0.5;
  o = vec4(clamp(r, 0.0, 1.0), 0.0, 0.0, 1.0);
}`, { uSrc: src, uBlur: smoothed, uMode: mode, uIntensity: Number(p.intensity), uScale: 0.08 / Number(p.radius) }, out);
    engine.release(smoothed);
    return { height: out };
  },
};

export const DATA_NODES: NodeDef[] = [SlopeNode, HeightMaskNode, CurvatureNode];
