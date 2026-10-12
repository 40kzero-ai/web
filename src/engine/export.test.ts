import { describe, it, expect } from 'vitest';
import { crc32, zlibStored, encodePNG } from './export';
import { inflateSync } from 'node:zlib';

describe('export', () => {
  it('crc32 matches reference', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
  it('stored zlib stream round-trips', () => {
    const data = new Uint8Array(200000).map((_, i) => (i * 7) & 0xff);
    const z = zlibStored(data);
    expect(new Uint8Array(inflateSync(Buffer.from(z)))).toEqual(data);
  });
  it('encodes a valid 16-bit grayscale PNG', async () => {
    const w = 3, h = 2;
    const px = new Uint16Array([0, 1000, 65535, 12, 34, 56]);
    const blob = await encodePNG(w, h, px, 1);
    const buf = new Uint8Array(await blob.arrayBuffer());
    expect(Array.from(buf.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const dv = new DataView(buf.buffer);
    expect(dv.getUint32(16)).toBe(w);
    expect(dv.getUint32(20)).toBe(h);
    expect(buf[24]).toBe(16); // bit depth
    expect(buf[25]).toBe(0); // grayscale
    // IDAT
    const idatLen = dv.getUint32(33);
    const idat = buf.subarray(41, 41 + idatLen);
    const raw = new Uint8Array(inflateSync(Buffer.from(idat)));
    expect(raw.length).toBe((w * 2 + 1) * h);
    expect(raw[0]).toBe(0);
    expect((raw[3] << 8) | raw[4]).toBe(1000);
    expect((raw[5] << 8) | raw[6]).toBe(65535);
  });
});
