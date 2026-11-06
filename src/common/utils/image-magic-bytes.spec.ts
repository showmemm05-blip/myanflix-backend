import sharp from 'sharp';
import {
  IMAGE_MIME_TO_EXTENSION,
  IMAGE_MIME_TYPES,
  matchesMagicBytes,
  sniffImageType,
} from './image-magic-bytes';

/**
 * The type of an uploaded image is decided by its first bytes and nothing
 * else (SEC-008 / SEC-019): a renamed PDF, SVG or HTML page must never be
 * stored under images/ as a picture, and a file cut short before its
 * signature is complete is not a picture either. Hand-built headers pin
 * the exact signatures; sharp-encoded images prove they are the ones real
 * encoders write.
 */
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const JPEG_HEADER = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
]);
/** RIFF <4 size bytes> WEBP, then the first chunk tag — what every WebP starts with. */
const WEBP_HEADER = Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 ', 'latin1');
const GIF89A_HEADER = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');
const GIF87A_HEADER = Buffer.from('GIF87a\x01\x00\x01\x00', 'latin1');

/** A real 2 x 2 image in the given format, written by sharp itself. */
const encoded = (format: 'jpeg' | 'png' | 'webp' | 'gif') =>
  sharp({
    create: { width: 2, height: 2, channels: 3, background: '#c82828' },
  })
    .toFormat(format)
    .toBuffer();

describe('image magic bytes', () => {
  describe('sniffImageType — valid headers of each accepted type', () => {
    it.each([
      ['JPEG', JPEG_HEADER, 'image/jpeg', '.jpg'],
      ['PNG', PNG_SIGNATURE, 'image/png', '.png'],
      ['WebP', WEBP_HEADER, 'image/webp', '.webp'],
      ['GIF89a', GIF89A_HEADER, 'image/gif', '.gif'],
      ['GIF87a', GIF87A_HEADER, 'image/gif', '.gif'],
    ])(
      'a %s header is read as its MIME and the matching extension',
      (_label, header, mimetype, extension) => {
        expect(sniffImageType(header)).toEqual({ mimetype, extension });
      },
    );

    it.each([
      ['jpeg', 'image/jpeg', '.jpg'],
      ['png', 'image/png', '.png'],
      ['webp', 'image/webp', '.webp'],
      ['gif', 'image/gif', '.gif'],
    ] as const)(
      'a real %s written by sharp is recognised the same way',
      async (format, mimetype, extension) => {
        expect(sniffImageType(await encoded(format))).toEqual({
          mimetype,
          extension,
        });
      },
    );
  });

  describe('sniffImageType — anything else is refused, whatever it was called', () => {
    it.each([
      ['a PDF', Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>')],
      [
        'an SVG',
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10"/>'),
      ],
      [
        'an SVG behind an XML prolog',
        Buffer.from(
          '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>',
        ),
      ],
      ['an SVG behind leading whitespace', Buffer.from('  \n\t<svg/>')],
      [
        'an HTML page',
        Buffer.from('<!DOCTYPE html><html><script>alert(1)</script></html>'),
      ],
      ['plain text', Buffer.from('bytes')],
      ['a BMP', Buffer.from('BM\x36\x00\x00\x00', 'latin1')],
      ['a TIFF', Buffer.from('II*\x00\x08\x00\x00\x00', 'latin1')],
      ['an empty file', Buffer.alloc(0)],
      ['a run of zero bytes', Buffer.alloc(64)],
    ])('%s is not an image', (_label, bytes) => {
      expect(sniffImageType(bytes)).toBeNull();
    });

    it.each([
      ['a JPEG cut after 2 bytes', JPEG_HEADER.subarray(0, 2)],
      [
        'a PNG cut after 7 of its 8 signature bytes',
        PNG_SIGNATURE.subarray(0, 7),
      ],
      [
        'a WebP cut before the WEBP tag is complete',
        WEBP_HEADER.subarray(0, 11),
      ],
      ['a GIF cut after "GIF8"', GIF89A_HEADER.subarray(0, 4)],
      ['a GIF cut after "GIF89"', GIF89A_HEADER.subarray(0, 5)],
    ])(
      '%s is refused — a truncated header is not a header',
      (_label, bytes) => {
        expect(sniffImageType(bytes)).toBeNull();
      },
    );

    it('a RIFF container that is not WebP (a WAV file) is refused', () => {
      expect(
        sniffImageType(Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'latin1')),
      ).toBeNull();
    });
  });

  describe('matchesMagicBytes — the declared MIME must agree with the bytes', () => {
    it.each([
      ['image/jpeg', JPEG_HEADER],
      ['image/png', PNG_SIGNATURE],
      ['image/webp', WEBP_HEADER],
      ['image/gif', GIF89A_HEADER],
      ['image/gif', GIF87A_HEADER],
    ])('%s matches its own header', (mimetype, bytes) => {
      expect(matchesMagicBytes(mimetype, bytes)).toBe(true);
    });

    it('rejects a declared type whose bytes are a different image (PNG bytes sent as image/jpeg)', () => {
      expect(matchesMagicBytes('image/jpeg', PNG_SIGNATURE)).toBe(false);
      expect(matchesMagicBytes('image/png', JPEG_HEADER)).toBe(false);
      expect(matchesMagicBytes('image/webp', GIF89A_HEADER)).toBe(false);
      expect(matchesMagicBytes('image/gif', WEBP_HEADER)).toBe(false);
    });

    it('never matches a type it does not know, even when the bytes are exactly that type', () => {
      expect(matchesMagicBytes('image/svg+xml', Buffer.from('<svg/>'))).toBe(
        false,
      );
      expect(
        matchesMagicBytes('application/pdf', Buffer.from('%PDF-1.7')),
      ).toBe(false);
      expect(matchesMagicBytes('', JPEG_HEADER)).toBe(false);
    });

    it('rejects a truncated header for every type', () => {
      expect(matchesMagicBytes('image/jpeg', JPEG_HEADER.subarray(0, 2))).toBe(
        false,
      );
      expect(matchesMagicBytes('image/png', PNG_SIGNATURE.subarray(0, 7))).toBe(
        false,
      );
      expect(matchesMagicBytes('image/webp', WEBP_HEADER.subarray(0, 11))).toBe(
        false,
      );
      expect(matchesMagicBytes('image/gif', GIF89A_HEADER.subarray(0, 5))).toBe(
        false,
      );
    });
  });

  describe('IMAGE_MIME_TO_EXTENSION', () => {
    it('names an extension, with its leading dot, for exactly the types that can be sniffed', () => {
      expect(Object.keys(IMAGE_MIME_TO_EXTENSION).sort()).toEqual(
        [...IMAGE_MIME_TYPES].sort(),
      );
      for (const extension of Object.values(IMAGE_MIME_TO_EXTENSION)) {
        expect(extension).toMatch(/^\.[a-z]+$/);
      }
    });
  });
});
