import { HEADER } from '../shaders/common';
import type { Engine } from './engine';
import type { Tex } from '../gl/texture';

/** Read an R32F texture as 16-bit unsigned samples (row 0 = top). */
export function readHeight16(engine: Engine, tex: Tex, lo = 0, hi = 1): Uint16Array {
  const packed = engine.alloc(tex.width, tex.height, 'RGBA8');
  engine.run('pack16', () => `${HEADER}
uniform sampler2D uSrc; uniform float uLo; uniform float uInvRange; out vec4 o;
void main() {
  float v = clamp((texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0).r - uLo) * uInvRange, 0.0, 1.0);
  float q = floor(v * 65535.0 + 0.5);
  float hi = floor(q / 256.0);
  float lo = q - hi * 256.0;
  o = vec4(hi / 255.0, lo / 255.0, 0.0, 1.0);
}`, { uSrc: tex, uLo: lo, uInvRange: 1 / Math.max(hi - lo, 1e-9) }, packed);
  const bytes = engine.pool.readBytes(packed);
  engine.release(packed);
  const w = tex.width, h = tex.height;
  const out = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) {
    const srcRow = (h - 1 - y) * w; // flip: GL row 0 is bottom
    const dstRow = y * w;
    for (let x = 0; x < w; x++) {
      const i = (srcRow + x) * 4;
      out[dstRow + x] = bytes[i] * 256 + bytes[i + 1];
    }
  }
  return out;
}

/** Read an RGBA8 texture as top-down RGBA bytes. */
export function readColor(engine: Engine, tex: Tex): Uint8Array {
  const bytes = engine.pool.readBytes(tex);
  const w = tex.width, h = tex.height;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) out.set(bytes.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array, start = 0, end = data.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(data: Uint8Array): number {
  let a = 1, b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** zlib stream using stored (uncompressed) deflate blocks — fallback when CompressionStream is unavailable. */
export function zlibStored(data: Uint8Array): Uint8Array {
  const blocks = Math.ceil(data.length / 65535) || 1;
  const out = new Uint8Array(2 + data.length + blocks * 5 + 4);
  let p = 0;
  out[p++] = 0x78; out[p++] = 0x01;
  for (let i = 0; i < blocks; i++) {
    const start = i * 65535;
    const len = Math.min(65535, data.length - start);
    out[p++] = i === blocks - 1 ? 1 : 0;
    out[p++] = len & 0xff; out[p++] = (len >> 8) & 0xff;
    out[p++] = ~len & 0xff; out[p++] = (~len >> 8) & 0xff;
    out.set(data.subarray(start, start + len), p);
    p += len;
  }
  const ad = adler32(data);
  out[p++] = (ad >>> 24) & 0xff; out[p++] = (ad >>> 16) & 0xff; out[p++] = (ad >>> 8) & 0xff; out[p++] = ad & 0xff;
  return out.subarray(0, p);
}

async function zlib(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') return zlibStored(data);
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  writer.write(data as unknown as BufferSource);
  writer.close();
  const buf = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(buf);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out[4] = type.charCodeAt(0); out[5] = type.charCodeAt(1); out[6] = type.charCodeAt(2); out[7] = type.charCodeAt(3);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/** Encode a PNG. `channels` 1 = 16-bit grayscale (data: Uint16Array), 4 = 8-bit RGBA (data: Uint8Array). */
export async function encodePNG(width: number, height: number, data: Uint16Array | Uint8Array, channels: 1 | 4): Promise<Blob> {
  const bytesPerPixel = channels === 1 ? 2 : 4;
  const stride = width * bytesPerPixel;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    raw[row] = 0; // filter none
    if (channels === 1) {
      const d = data as Uint16Array;
      for (let x = 0; x < width; x++) {
        const v = d[y * width + x];
        raw[row + 1 + x * 2] = v >> 8;
        raw[row + 2 + x * 2] = v & 0xff;
      }
    } else {
      raw.set((data as Uint8Array).subarray(y * stride, (y + 1) * stride), row + 1);
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height);
  ihdr[8] = channels === 1 ? 16 : 8;
  ihdr[9] = channels === 1 ? 0 : 6;
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = await zlib(raw);
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))] as unknown as BlobPart[];
  return new Blob(parts, { type: 'image/png' });
}

/** Little-endian 16-bit RAW (Unity / Unreal compatible .r16). */
export function encodeRaw16(data: Uint16Array): Blob {
  const out = new Uint8Array(data.length * 2);
  for (let i = 0; i < data.length; i++) {
    out[i * 2] = data[i] & 0xff;
    out[i * 2 + 1] = data[i] >> 8;
  }
  return new Blob([out as unknown as BlobPart], { type: 'application/octet-stream' });
}

export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
