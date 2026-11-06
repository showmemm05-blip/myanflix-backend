import { ISO_BMFF_HEADER_BYTES, isIsoBmff } from './video-magic-bytes';

describe('isIsoBmff', () => {
  const mp4 = (brand: string) =>
    Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from('ftyp', 'latin1'),
      Buffer.from(brand, 'latin1'),
    ]);

  it('accepts the ftyp box whatever the brand', () => {
    expect(isIsoBmff(mp4('isom'))).toBe(true);
    expect(isIsoBmff(mp4('mp42'))).toBe(true);
    expect(isIsoBmff(mp4('qt  '))).toBe(true);
  });

  it('refuses anything else, short buffers included', () => {
    expect(isIsoBmff(Buffer.from('RIFF....WEBPVP8 ', 'latin1'))).toBe(false);
    expect(isIsoBmff(Buffer.from('#!/bin/sh\n', 'latin1'))).toBe(false);
    expect(isIsoBmff(Buffer.alloc(0))).toBe(false);
    expect(isIsoBmff(Buffer.from('ftyp', 'latin1'))).toBe(false);
  });

  it('needs no more than the header read', () => {
    expect(ISO_BMFF_HEADER_BYTES).toBeGreaterThanOrEqual(8);
  });
});
