import {
  RENDITION_TIERS,
  WIDE_ELIGIBILITY_RATIO,
  fitInsideBox,
  isTierEligible,
  pickRenditions,
} from './rendition-tiers';

const ALL = ['1080p', '720p', '480p', '360p', '240p'];

const names = (tiers: { name: string }[]) => tiers.map((t) => t.name);
const tier = (name: string) => RENDITION_TIERS.find((t) => t.name === name)!;

/** name -> "WxH" for every rung a source earns — what the probe table in the brief reads. */
const sizes = (sourceWidth: number, sourceHeight: number) =>
  Object.fromEntries(
    pickRenditions(sourceWidth, sourceHeight).map((t) => {
      const { width, height } = fitInsideBox(t, sourceWidth, sourceHeight);
      return [t.name, `${width}x${height}`];
    }),
  );

describe('RENDITION_TIERS', () => {
  it('names every rung after its box height and keeps every box 16:9 with even sides', () => {
    for (const t of RENDITION_TIERS) {
      expect(t.name).toBe(`${t.height}p`);
      expect(t.width % 2).toBe(0);
      expect(t.height % 2).toBe(0);
      // 854x480 and 426x240 are the even roundings of 16:9.
      expect(Math.abs(t.width - (t.height * 16) / 9)).toBeLessThan(2);
    }
  });

  it('lists the boxes highest first — the order the classic flow transcodes in', () => {
    expect(RENDITION_TIERS.map((t) => `${t.width}x${t.height}`)).toEqual([
      '1920x1080',
      '1280x720',
      '854x480',
      '640x360',
      '426x240',
    ]);
  });
});

describe('pickRenditions — which rungs a source earns', () => {
  it('a 16:9 1080p source earns every rung and a 16:9 720p source everything up to 720p — exactly as before', () => {
    expect(names(pickRenditions(1920, 1080))).toEqual(ALL);
    expect(names(pickRenditions(1280, 720))).toEqual([
      '720p',
      '480p',
      '360p',
      '240p',
    ]);
  });

  it('a widescreen film with its bars cropped (1920x800) now earns 1080p instead of topping out at 720p', () => {
    expect(names(pickRenditions(1920, 800))).toEqual(ALL);
    expect(isTierEligible(tier('1080p'), 1920, 800)).toBe(true);
  });

  it('tolerates a cropped encode a few pixels short of the box width (1904x800), but not more than 2%', () => {
    expect(names(pickRenditions(1904, 800))).toEqual(ALL);
    expect(WIDE_ELIGIBILITY_RATIO).toBe(0.98);
    // 1920 * 0.98 = 1881.6: 1882 wide still earns 1080p, 1880 does not.
    expect(isTierEligible(tier('1080p'), 1882, 800)).toBe(true);
    expect(names(pickRenditions(1880, 800))).toEqual([
      '720p',
      '480p',
      '360p',
      '240p',
    ]);
  });

  it('keeps the height rule for 4:3 and vertical sources, so they earn what they always did', () => {
    expect(names(pickRenditions(1440, 1080))).toEqual(ALL);
    expect(names(pickRenditions(1080, 1920))).toEqual(ALL);
    expect(names(pickRenditions(320, 240))).toEqual(['240p']);
  });

  it('never upscales into a rung: 1600x900 is neither wide enough nor tall enough for 1080p', () => {
    expect(names(pickRenditions(1600, 900))).toEqual([
      '720p',
      '480p',
      '360p',
      '240p',
    ]);
    expect(isTierEligible(tier('1080p'), 1600, 900)).toBe(false);
  });

  it('a small 640x360 source earns 360p and 240p only', () => {
    expect(names(pickRenditions(640, 360))).toEqual(['360p', '240p']);
  });

  it('falls back to the single smallest rung when nothing is eligible — including an unprobeable 0x0', () => {
    expect(names(pickRenditions(200, 100))).toEqual(['240p']);
    expect(names(pickRenditions(0, 0))).toEqual(['240p']);
  });
});

/**
 * Every size here was checked against a real ffmpeg 8.1.2 run of the exact
 * filter (scale=w=<boxW>:h=<boxH>:force_original_aspect_ratio=decrease:
 * force_divisible_by=2) on testsrc2 sources of the same dimensions.
 */
describe('fitInsideBox — the real output size the scale filter produces', () => {
  it('a 16:9 source fills every box exactly: byte-for-byte the sizes scale=-2:<h> gave', () => {
    expect(sizes(1280, 720)).toEqual({
      '720p': '1280x720',
      '480p': '854x480',
      '360p': '640x360',
      '240p': '426x240',
    });
    expect(sizes(1920, 1080)).toEqual({
      '1080p': '1920x1080',
      '720p': '1280x720',
      '480p': '854x480',
      '360p': '640x360',
      '240p': '426x240',
    });
  });

  it('a 1920x800 film keeps its shape in every rung — 1920x800 at 1080p, 1280x534 at 720p', () => {
    expect(sizes(1920, 800)).toEqual({
      '1080p': '1920x800',
      '720p': '1280x534',
      '480p': '854x356',
      '360p': '640x266',
      '240p': '426x178',
    });
  });

  it('a 1904x800 cropped encode is scaled by the tolerated 0.8% to fill the box width', () => {
    expect(sizes(1904, 800)).toEqual({
      '1080p': '1920x806',
      '720p': '1280x538',
      '480p': '854x358',
      '360p': '640x268',
      '240p': '426x178',
    });
  });

  it('4:3 and vertical sources are height-limited and come out exactly as before', () => {
    expect(sizes(1440, 1080)).toEqual({
      '1080p': '1440x1080',
      '720p': '960x720',
      '480p': '640x480',
      '360p': '480x360',
      '240p': '320x240',
    });
    expect(sizes(1080, 1920)).toEqual({
      '1080p': '608x1080',
      '720p': '406x720',
      '480p': '270x480',
      '360p': '202x360',
      '240p': '136x240',
    });
  });

  it('rounds halves up like libavfilter (a 1080x1920 720p rung is 406 wide, not 404) and clamps to the box (an 854x480 source at 240p is 426 wide, where scale=-2:240 gave 428)', () => {
    expect(fitInsideBox(tier('720p'), 1080, 1920)).toEqual({
      width: 406,
      height: 720,
    });
    expect(fitInsideBox(tier('240p'), 854, 480)).toEqual({
      width: 426,
      height: 240,
    });
  });

  it('never exceeds the box and always returns even sides', () => {
    const sources: [number, number][] = [
      [1920, 800],
      [1904, 800],
      [1440, 1080],
      [1080, 1920],
      [854, 480],
      [1366, 768],
      [1920, 1088],
      [3840, 1600],
      [200, 100],
    ];
    for (const [sourceWidth, sourceHeight] of sources) {
      for (const t of RENDITION_TIERS) {
        const { width, height } = fitInsideBox(t, sourceWidth, sourceHeight);
        expect(width).toBeLessThanOrEqual(t.width);
        expect(height).toBeLessThanOrEqual(t.height);
        expect(width % 2).toBe(0);
        expect(height % 2).toBe(0);
        expect(width).toBeGreaterThan(0);
        expect(height).toBeGreaterThan(0);
      }
    }
  });

  it('the fallback rung for a tiny source upscales into the 240p box, as scale=-2:240 did', () => {
    expect(sizes(200, 100)).toEqual({ '240p': '426x214' });
  });

  it('reports the box itself when the source size is unknown — the old 16:9 guess', () => {
    expect(fitInsideBox(tier('720p'), 0, 0)).toEqual({
      width: 1280,
      height: 720,
    });
  });
});
