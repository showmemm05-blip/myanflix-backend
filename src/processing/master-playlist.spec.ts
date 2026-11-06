import {
  PREFERRED_START_HEIGHT,
  buildMasterPlaylist,
  orderVariantsForMaster,
  type MasterVariant,
} from './master-playlist';
import {
  RENDITION_TIERS,
  fitInsideBox,
  pickRenditions,
} from './rendition-tiers';

/** The classic flow's variant entries for a source, exactly as ProcessingService builds them. */
const variantsFor = (
  sourceWidth: number,
  sourceHeight: number,
): MasterVariant[] =>
  pickRenditions(sourceWidth, sourceHeight).map((tier) => ({
    name: tier.name,
    tierHeight: tier.height,
    bandwidth: tier.bandwidth,
    ...fitInsideBox(tier, sourceWidth, sourceHeight),
  }));

const names = (variants: { name: string }[]) => variants.map((v) => v.name);

describe('orderVariantsForMaster', () => {
  it('lists the 480p rung first, then the rest highest to lowest', () => {
    expect(PREFERRED_START_HEIGHT).toBe(480);
    expect(names(orderVariantsForMaster(variantsFor(1920, 1080)))).toEqual([
      '480p',
      '1080p',
      '720p',
      '360p',
      '240p',
    ]);
    expect(names(orderVariantsForMaster(variantsFor(1280, 720)))).toEqual([
      '480p',
      '720p',
      '360p',
      '240p',
    ]);
  });

  it('ranks by the rung, not by the output height — a widescreen film\'s 854x356 "480p" still leads', () => {
    const ordered = orderVariantsForMaster(variantsFor(1920, 800));

    expect(ordered[0]).toMatchObject({ name: '480p', width: 854, height: 356 });
    expect(names(ordered)).toEqual(['480p', '1080p', '720p', '360p', '240p']);
  });

  it('without a 480p rung the highest rung at or below 480 leads', () => {
    const without480 = variantsFor(1280, 720).filter((v) => v.name !== '480p');

    expect(names(orderVariantsForMaster(without480))).toEqual([
      '360p',
      '720p',
      '240p',
    ]);
  });

  it('with nothing at or below 480 the lowest rung leads', () => {
    const highOnly = variantsFor(1920, 1080).filter((v) => v.tierHeight > 480);

    expect(names(orderVariantsForMaster(highOnly))).toEqual(['720p', '1080p']);
  });

  it('a single rung is listed as is, and an empty ladder stays empty', () => {
    expect(names(orderVariantsForMaster(variantsFor(200, 100)))).toEqual([
      '240p',
    ]);
    expect(orderVariantsForMaster([])).toEqual([]);
  });

  it('does not depend on the input order and leaves the input untouched', () => {
    const lowestFirst = [...variantsFor(1920, 1080)].reverse();
    const snapshot = [...lowestFirst];

    expect(names(orderVariantsForMaster(lowestFirst))).toEqual([
      '480p',
      '1080p',
      '720p',
      '360p',
      '240p',
    ]);
    expect(lowestFirst).toEqual(snapshot);
  });
});

describe('buildMasterPlaylist', () => {
  it('writes a 16:9 720p source with the sizes and BANDWIDTH values it always had, 480p first', () => {
    expect(buildMasterPlaylist(variantsFor(1280, 720))).toBe(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-STREAM-INF:BANDWIDTH=1528000,RESOLUTION=854x480',
        '480p/index.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=2928000,RESOLUTION=1280x720',
        '720p/index.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=928000,RESOLUTION=640x360',
        '360p/index.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=528000,RESOLUTION=426x240',
        '240p/index.m3u8',
      ].join('\n') + '\n',
    );
  });

  it('states the REAL output size of a 1920x800 film in every RESOLUTION, never the box', () => {
    expect(buildMasterPlaylist(variantsFor(1920, 800))).toBe(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-STREAM-INF:BANDWIDTH=1528000,RESOLUTION=854x356',
        '480p/index.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=5128000,RESOLUTION=1920x800',
        '1080p/index.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=2928000,RESOLUTION=1280x534',
        '720p/index.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=928000,RESOLUTION=640x266',
        '360p/index.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=528000,RESOLUTION=426x178',
        '240p/index.m3u8',
      ].join('\n') + '\n',
    );
  });

  it('keeps every BANDWIDTH exactly as RENDITION_TIERS declares it', () => {
    const master = buildMasterPlaylist(variantsFor(1920, 1080));

    for (const tier of RENDITION_TIERS) {
      expect(master).toContain(
        `#EXT-X-STREAM-INF:BANDWIDTH=${tier.bandwidth},RESOLUTION=${tier.width}x${tier.height}\n${tier.name}/index.m3u8\n`,
      );
    }
  });

  it('uses LF line endings and ends with a newline — the shape the subtitle rewrite preserves', () => {
    const master = buildMasterPlaylist(variantsFor(1280, 720));

    expect(master).not.toContain('\r');
    expect(master.endsWith('\n')).toBe(true);
  });
});
