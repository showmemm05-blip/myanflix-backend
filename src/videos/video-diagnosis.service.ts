import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VideoStatus, type Video } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { resolveRelativeKey } from '../subtitles/hls-subtitle-manifest';
import { VideosService } from './videos.service';

/** What the admin's "Check playback" button renders — one line per check. */
export interface DiagnosisCheck {
  /** Stable machine key; the admin maps it to a label, never the detail. */
  name: string;
  ok: boolean;
  /** English diagnostic text shown verbatim, like failureReason today. */
  detail: string;
}

export type SuggestedAction = 'none' | 'reprocess' | 'replace';

export interface VideoDiagnosis {
  ok: boolean;
  suggestedAction: SuggestedAction;
  checks: DiagnosisCheck[];
}

// How long the server-side fetch of the signed master may take. The cache
// server answers a playlist in milliseconds; anything slower than this is a
// routing problem worth reporting, not a slow day.
const CACHESERVER_PROBE_TIMEOUT_MS = 5_000;

// A media playlist can be a few hundred KB for a long title; the first
// segment URI is within the first lines, so the probe reads a bounded head.
const PLAYLIST_HEAD_BYTES = 256 * 1024;

// Checks that exist only once a Video row does — listed so a title with no
// row still reports the whole checklist (each as "skipped") instead of one
// lonely red line the admin has to interpret.
const ROW_DEPENDENT_CHECKS = [
  'video_status',
  'original_object',
  'hls_master',
  'renditions_json',
  'segment_sample',
  'cacheserver_master',
] as const;

interface ParsedRendition {
  resolution: string;
  playlistPath: string;
}

/**
 * Staff-only, on-demand diagnosis of why a title does or does not play —
 * `GET /videos/:movieId/diagnose`. Every check is a real look at the thing a
 * viewer's player would touch: the Video row, each object the row points at
 * (HEAD against MinIO), the first segment the top rendition's playlist
 * names, the signed master fetched THROUGH the cache server exactly as a
 * client would fetch it, and every subtitle source. It never writes, never
 * signs in anywhere and never puts a credential in a detail line — the only
 * token that appears is the same playback token `/stream` already hands
 * to every viewer.
 *
 * Separate from VideosService so the playback bootstrap stays lean (a
 * diagnosis is ~10 MinIO round-trips plus an HTTP fetch, which is why the
 * route is NOT throttle-exempt and the admin only runs it on demand).
 *
 * `suggestedAction` is the one piece of interpretation: whether the
 * operator's fix is a re-transcode from the archived original (`reprocess`,
 * POST /uploads/:movieId/reprocess), a new bundle (`replace`, the
 * finalize-replace flow), or nothing media-related (`none` — a cache-server
 * or subtitle problem the red lines already describe).
 */
@Injectable()
export class VideoDiagnosisService {
  private readonly logger = new Logger(VideoDiagnosisService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
    private readonly videosService: VideosService,
    private readonly configService: ConfigService,
  ) {}

  async diagnose(movieId: string): Promise<VideoDiagnosis> {
    const movie = await this.prisma.movie.findUnique({
      where: { id: movieId },
      select: { id: true },
    });
    if (!movie) throw new NotFoundException('Movie not found');

    const checks: DiagnosisCheck[] = [];
    const video = await this.videosService.findLatestForMovie(movieId);

    if (!video) {
      checks.push({
        name: 'video_row',
        ok: false,
        detail:
          'no Video row for this movie — nothing has ever been uploaded or finalized',
      });
      for (const name of ROW_DEPENDENT_CHECKS) {
        checks.push({ name, ok: false, detail: 'skipped' });
      }
      return { ok: false, suggestedAction: 'replace', checks };
    }

    checks.push({
      name: 'video_row',
      ok: true,
      detail: `video ${video.id} created ${video.createdAt.toISOString()}`,
    });
    checks.push({
      name: 'video_status',
      ok: video.status === VideoStatus.READY,
      detail: `status=${video.status}${
        video.failureReason ? ` failureReason=${video.failureReason}` : ''
      }`,
    });

    const originalCheck = await this.checkOriginal(video);
    checks.push(originalCheck);

    const masterCheck = await this.checkMaster(video);
    checks.push(masterCheck);

    const { check: renditionsCheck, renditions } = this.parseRenditions(
      video.renditions,
    );
    checks.push(renditionsCheck);
    const renditionChecks = await Promise.all(
      renditions.map(async (rendition) => ({
        name: `rendition:${rendition.resolution}`,
        ok: await this.minioService.objectExists(rendition.playlistPath),
        detail: rendition.playlistPath,
      })),
    );
    checks.push(...renditionChecks);

    const segmentCheck = await this.checkSegmentSample(renditions);
    checks.push(segmentCheck);

    if (masterCheck.ok && video.hlsMasterPath) {
      checks.push(await this.checkCacheserver(video.hlsMasterPath));
    } else {
      checks.push({
        name: 'cacheserver_master',
        ok: false,
        detail: 'skipped — no master to fetch',
      });
    }

    const subtitles = await this.prisma.subtitle.findMany({
      where: { videoId: video.id },
      orderBy: { createdAt: 'asc' },
    });
    for (const subtitle of subtitles) {
      checks.push({
        name: `subtitle_source:${subtitle.label}`,
        ok: await this.minioService.objectExists(subtitle.objectKey),
        detail: `${subtitle.language} ${subtitle.format} ${subtitle.objectKey}`,
      });
    }

    const mediaBroken =
      !renditionsCheck.ok ||
      renditionChecks.some((check) => !check.ok) ||
      !segmentCheck.ok;

    return {
      ok: checks.every((check) => check.ok),
      suggestedAction: this.suggest(
        video.status,
        originalCheck.ok,
        masterCheck.ok,
        mediaBroken,
      ),
      checks,
    };
  }

  /**
   * The decision matrix, in the order the checks are trusted:
   *  - not READY (FAILED / orphaned PROCESSING): the pipeline can be re-run
   *    from the archived original when it exists, else a new bundle is the
   *    only way back; a row stuck at UPLOADING never had its original
   *    archived, so that too is a replace.
   *  - READY but the master is gone: same choice (reprocessVideo accepts
   *    exactly this case).
   *  - READY with a master but a rendition/segment missing: the HLS package
   *    is partial — a transcode would rebuild it too, but the operator's
   *    stated remedy for a broken package is a fresh bundle.
   *  - everything media-side present: a red cacheserver_master or subtitle
   *    line is config/subtitle work, not a media action.
   */
  private suggest(
    status: VideoStatus,
    originalOk: boolean,
    masterOk: boolean,
    mediaBroken: boolean,
  ): SuggestedAction {
    if (status !== VideoStatus.READY) {
      if (status === VideoStatus.UPLOADING) return 'replace';
      return originalOk ? 'reprocess' : 'replace';
    }
    if (!masterOk) return originalOk ? 'reprocess' : 'replace';
    if (mediaBroken) return 'replace';
    return 'none';
  }

  private async checkOriginal(video: Video): Promise<DiagnosisCheck> {
    const name = 'original_object';
    // A failed classic upload can leave originalPath as the LOCAL scratch
    // path it died with (archiving is the first pipeline step); that is not
    // an object anyone can HEAD, and reprocess would only find it if the
    // scratch file survived — reported honestly rather than probed.
    if (!video.originalPath || video.originalPath.startsWith('/')) {
      return {
        name,
        ok: false,
        detail: video.originalPath
          ? `original never archived (local scratch path ${video.originalPath})`
          : 'no original path recorded',
      };
    }
    const size = await this.minioService.objectSize(video.originalPath);
    return size === null
      ? { name, ok: false, detail: `${video.originalPath} is missing` }
      : { name, ok: true, detail: `${video.originalPath} (${size} bytes)` };
  }

  private async checkMaster(video: Video): Promise<DiagnosisCheck> {
    const name = 'hls_master';
    if (!video.hlsMasterPath) {
      return { name, ok: false, detail: 'no master path' };
    }
    const exists = await this.minioService.objectExists(video.hlsMasterPath);
    return {
      name,
      ok: exists,
      detail: exists
        ? video.hlsMasterPath
        : `${video.hlsMasterPath} is missing`,
    };
  }

  /**
   * Parsed TOTALLY, like VideosService.buildQualities: `renditions` is a Json
   * column and holds whatever was written into it. Unlike the player path,
   * which silently drops a bad entry, a diagnosis names it.
   */
  private parseRenditions(raw: unknown): {
    check: DiagnosisCheck;
    renditions: ParsedRendition[];
  } {
    const name = 'renditions_json';
    if (!Array.isArray(raw)) {
      return {
        check: {
          name,
          ok: false,
          detail: `renditions is not a list (${raw === null || raw === undefined ? 'empty' : typeof raw})`,
        },
        renditions: [],
      };
    }

    const renditions: ParsedRendition[] = [];
    const malformed: string[] = [];
    raw.forEach((entry, index) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        malformed.push(`#${index} is not an object`);
        return;
      }
      const { resolution, playlistPath } = entry as {
        resolution?: unknown;
        playlistPath?: unknown;
      };
      if (typeof resolution !== 'string' || resolution.trim() === '') {
        malformed.push(`#${index} has no resolution`);
        return;
      }
      if (typeof playlistPath !== 'string' || playlistPath.trim() === '') {
        malformed.push(`#${index} (${resolution}) has no playlistPath`);
        return;
      }
      renditions.push({ resolution, playlistPath });
    });

    if (malformed.length > 0) {
      return {
        check: { name, ok: false, detail: malformed.join('; ') },
        renditions,
      };
    }
    if (renditions.length === 0) {
      return {
        check: { name, ok: false, detail: 'no renditions recorded' },
        renditions,
      };
    }
    return {
      check: {
        name,
        ok: true,
        detail: renditions.map((r) => r.resolution).join(', '),
      },
      renditions,
    };
  }

  /**
   * Reads the TOP rendition's playlist and HEADs the first segment it names
   * — the cheapest proof that the package is more than playlists. The URI is
   * resolved relative to the playlist's folder exactly as a player would;
   * an absolute URI or a `..` hop would point outside the title's scope and
   * is reported rather than followed.
   */
  private async checkSegmentSample(
    renditions: ParsedRendition[],
  ): Promise<DiagnosisCheck> {
    const name = 'segment_sample';
    if (renditions.length === 0) {
      return { name, ok: false, detail: 'skipped — no rendition to sample' };
    }
    const height = (label: string): number => {
      const match = /(\d+)/.exec(label);
      return match ? Number(match[1]) : -1;
    };
    const top = [...renditions].sort(
      (a, b) => height(b.resolution) - height(a.resolution),
    )[0];

    let playlist: string;
    try {
      playlist = (
        await this.minioService.readBytes(top.playlistPath, PLAYLIST_HEAD_BYTES)
      ).toString('utf-8');
    } catch (error) {
      return {
        name,
        ok: false,
        detail: `could not read ${top.playlistPath}: ${describeError(error)}`,
      };
    }

    const uri = playlist
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '' && !line.startsWith('#'));
    if (!uri) {
      return {
        name,
        ok: false,
        detail: `${top.playlistPath} names no segment in its first ${PLAYLIST_HEAD_BYTES} bytes`,
      };
    }
    if (
      uri.startsWith('/') ||
      /^[a-z][a-z0-9+.-]*:/i.test(uri) ||
      uri.split('/').some((segment) => segment === '..')
    ) {
      return {
        name,
        ok: false,
        detail: `${top.playlistPath} names a segment outside its folder (${uri})`,
      };
    }

    const segmentKey = resolveRelativeKey(top.playlistPath, uri);
    const exists = await this.minioService.objectExists(segmentKey);
    return {
      name,
      ok: exists,
      detail: exists ? segmentKey : `${segmentKey} is missing`,
    };
  }

  /**
   * Fetches the signed master the way a viewer would — same path, same
   * token — but through the backend's own route to the cache server. The
   * request-derived playback host is what a CLIENT should use; inside the
   * backend container it is often `localhost`, i.e. this very container,
   * so STREAM_INTERNAL_BASE_URL (docker-compose: host.docker.internal:8080)
   * substitutes the origin only. The detail names both URLs so a false red
   * from a wrong reach address explains itself.
   */
  private async checkCacheserver(
    hlsMasterPath: string,
  ): Promise<DiagnosisCheck> {
    const name = 'cacheserver_master';
    let clientUrl: string;
    let signedPath: string;
    try {
      clientUrl = this.minioService.signedPlaybackUrl(hlsMasterPath);
      signedPath = this.minioService.signedPlaybackPath(hlsMasterPath);
    } catch (error) {
      return {
        name,
        ok: false,
        detail: `master path cannot be signed: ${describeError(error)}`,
      };
    }

    const reachBase = (
      this.configService.get<string>('STREAM_INTERNAL_BASE_URL') ||
      this.minioService.playbackBaseUrl()
    ).replace(/\/$/, '');
    const fetched = `${reachBase}${signedPath}`;
    const prefix = `client url=${clientUrl} fetched=${fetched}`;

    try {
      const response = await globalThis.fetch(fetched, {
        signal: AbortSignal.timeout(CACHESERVER_PROBE_TIMEOUT_MS),
        redirect: 'manual',
      });
      const head = (await response.text()).slice(0, 7);
      if (response.status === 200 && head === '#EXTM3U') {
        return { name, ok: true, detail: `${prefix} status=200` };
      }
      const why =
        response.status === 403
          ? ' signature rejected (STREAM_SIGNING_SECRET mismatch?)'
          : response.status === 410
            ? ' token expired'
            : response.status === 200
              ? ' body is not an HLS playlist'
              : '';
      return {
        name,
        ok: false,
        detail: `${prefix} status=${response.status}${why}`,
      };
    } catch (error) {
      const timedOut =
        error instanceof Error &&
        (error.name === 'TimeoutError' || error.name === 'AbortError');
      this.logger.warn(
        `Cache server probe failed for ${fetched}: ${describeError(error)}`,
      );
      return {
        name,
        ok: false,
        detail: `${prefix} status=${
          timedOut
            ? `timeout — no answer within ${CACHESERVER_PROBE_TIMEOUT_MS / 1000} s`
            : describeError(error)
        }`,
      };
    }
  }
}

/** `name: message`, with the underlying cause's code when fetch wraps one (ECONNREFUSED etc.). */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: { code?: unknown } }).cause;
  const code =
    cause && typeof cause === 'object' && typeof cause.code === 'string'
      ? ` (${cause.code})`
      : '';
  return `${error.name}: ${error.message}${code}`;
}
