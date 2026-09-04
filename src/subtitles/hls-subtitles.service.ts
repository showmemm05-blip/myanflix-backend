import { Injectable, Logger } from '@nestjs/common';
import { SubtitleFormat, VideoStatus } from '../generated/prisma/client';
import type { Subtitle, Video } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { StorageService } from '../common/storage/storage.service';
import { srtToVtt, withHlsTimestampMap } from './srt-to-vtt';
import { initialPtsFromTransportStream, PTS_PROBE_BYTES } from './mpegts-pts';
import {
  buildSubtitleMediaPlaylist,
  firstSegmentUri,
  firstVariantUri,
  resolveRelativeKey,
  rewriteMasterPlaylist,
  totalDurationFromMediaPlaylist,
  type SubtitleRendition,
} from './hls-subtitle-manifest';

export interface PublishedSubtitle {
  id: string;
  language: string;
  label: string;
  isDefault: boolean;
  vttKey: string;
  playlistKey: string;
}

export interface ExcludedSubtitle {
  id: string;
  format: SubtitleFormat;
  reason: string;
}

export interface SubtitlePublishResult {
  videoId: string;
  movieId: string | null;
  masterKey: string | null;
  /** False when the master already said exactly this — the idempotent re-run. */
  masterUpdated: boolean;
  published: PublishedSubtitle[];
  /** Rows kept in the database but deliberately left out of the manifest. */
  excluded: ExcludedSubtitle[];
  /** Set when the whole publish was a no-op, explaining why. */
  skipped?: string;
}

/** What the published rendition has to line up with — see resolveTimeline(). */
interface PublishTimeline {
  /** Seconds the single WebVTT segment must span; 0 means "unknown". */
  durationSeconds: number;
  /** MPEG-TS PTS (90 kHz ticks) the presentation's t=0 actually sits at. */
  initialPts: number;
}

/**
 * Publishes a video's subtitle tracks INTO its HLS master playlist.
 *
 * Why the manifest and not a `<track>` element: expo-video (mobile) can only
 * surface subtitle tracks it discovers inside the manifest — its VideoSource
 * has no field for an external text track at all. A `<track>` would fix the
 * web and leave mobile broken, whereas one `#EXT-X-MEDIA:TYPE=SUBTITLES`
 * rendition is consumed by hls.js (`hls.subtitleTracks`) and expo-video
 * (`availableSubtitleTracks`) alike.
 *
 * Everything here converges on the database rather than accumulating: each
 * run re-derives the whole subtitle group from the current rows, so create,
 * delete, rename and set-default all go through the same code path, and
 * running it twice changes nothing the second time.
 */
@Injectable()
export class HlsSubtitlesService {
  private readonly logger = new Logger(HlsSubtitlesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
    private readonly storageService: StorageService,
  ) {}

  /** Publishes for a movie's most recent video — the one getStreamInfo() serves. */
  async publishForMovie(movieId: string): Promise<SubtitlePublishResult> {
    const video = await this.prisma.video.findFirst({
      where: { movieId },
      orderBy: { createdAt: 'desc' },
    });
    if (!video) {
      return {
        videoId: '',
        movieId,
        masterKey: null,
        masterUpdated: false,
        published: [],
        excluded: [],
        skipped: 'this movie has no video yet',
      };
    }
    return this.publishForVideo(video.id);
  }

  async publishForVideo(videoId: string): Promise<SubtitlePublishResult> {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
    });

    if (!video) {
      return this.noop(videoId, null, 'no such video');
    }
    if (video.status !== VideoStatus.READY || !video.hlsMasterPath) {
      // Perfectly normal: an admin can attach a subtitle while the transcode
      // is still running. ProcessingService re-publishes once it is READY.
      return this.noop(
        videoId,
        video.movieId,
        'the video is not READY yet — its subtitles will be published when transcoding finishes',
      );
    }

    const subtitles = await this.prisma.subtitle.findMany({
      where: { videoId },
      // Stable order => a stable master playlist => byte-identical re-runs.
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    const masterKey = video.hlsMasterPath;
    const master = await this.minioService.readText(masterKey);
    const timeline = await this.resolveTimeline(video, master);

    const published: PublishedSubtitle[] = [];
    const excluded: ExcludedSubtitle[] = [];

    for (const subtitle of subtitles) {
      if (subtitle.format === SubtitleFormat.ASS) {
        // ASS/SSA is a styled format neither hls.js nor a native HLS player
        // can render. The row stays (the admin still lists and can delete
        // it) but it must never enter the manifest — a rendition pointing at
        // an unrenderable track is worse than no rendition at all.
        excluded.push({
          id: subtitle.id,
          format: subtitle.format,
          reason:
            'ASS/SSA cannot be converted to WebVTT — neither the web nor the mobile player can render it, so it is kept in the database but left out of the HLS manifest',
        });
        continue;
      }

      try {
        published.push(
          await this.writeRendition(video.movieId, subtitle, timeline),
        );
      } catch (error) {
        // One unreadable source file must not cost the title every other
        // track, and it must NOT be advertised either: a rendition whose
        // .vtt 404s makes players stall on the subtitle load.
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Skipping subtitle ${subtitle.id} for movie ${video.movieId}: ${reason}`,
        );
        excluded.push({
          id: subtitle.id,
          format: subtitle.format,
          reason: `could not be published: ${reason}`,
        });
      }
    }

    const renditions: SubtitleRendition[] = published.map((entry) => ({
      id: entry.id,
      label: entry.label,
      language: entry.language,
      isDefault: entry.isDefault,
    }));

    const rewritten = rewriteMasterPlaylist(master, renditions);
    const masterUpdated = rewritten !== master;
    if (masterUpdated) {
      await this.minioService.uploadBuffer(
        masterKey,
        Buffer.from(rewritten, 'utf-8'),
      );
    }

    this.logger.log(
      `Published ${published.length} subtitle rendition(s) for movie ${video.movieId}` +
        `${excluded.length > 0 ? `, excluded ${excluded.length}` : ''}` +
        `${masterUpdated ? '' : ' (master already up to date)'}`,
    );

    return {
      videoId,
      movieId: video.movieId,
      masterKey,
      masterUpdated,
      published,
      excluded,
    };
  }

  /**
   * Deletes one track's published objects. Called on delete AFTER the master
   * has been rewritten without it, so a failure here can only ever leave an
   * unreferenced object behind, never a manifest pointing at a missing one.
   * Best-effort: an object that is already gone is the expected outcome for a
   * row that was never publishable (ASS).
   */
  async unpublishSubtitle(movieId: string, subtitleId: string): Promise<void> {
    const keys = [
      this.storageService.hlsSubtitleVttKey(movieId, subtitleId),
      this.storageService.hlsSubtitlePlaylistKey(movieId, subtitleId),
    ];
    for (const key of keys) {
      try {
        await this.minioService.deleteObject(key);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Could not delete ${key}: ${reason}`);
      }
    }
  }

  private async writeRendition(
    movieId: string,
    subtitle: Subtitle,
    timeline: PublishTimeline,
  ): Promise<PublishedSubtitle> {
    const source = await this.minioService.readText(subtitle.objectKey);
    const vtt = withHlsTimestampMap(srtToVtt(source), timeline.initialPts);

    const vttKey = this.storageService.hlsSubtitleVttKey(movieId, subtitle.id);
    const playlistKey = this.storageService.hlsSubtitlePlaylistKey(
      movieId,
      subtitle.id,
    );

    await this.minioService.uploadBuffer(vttKey, Buffer.from(vtt, 'utf-8'));
    await this.minioService.uploadBuffer(
      playlistKey,
      Buffer.from(
        buildSubtitleMediaPlaylist(subtitle.id, timeline.durationSeconds),
        'utf-8',
      ),
    );

    return {
      id: subtitle.id,
      language: subtitle.language,
      label: subtitle.label,
      isDefault: subtitle.isDefault,
      vttKey,
      playlistKey,
    };
  }

  /**
   * The two facts about the media that a rendition has to agree with, both
   * recovered from the title's first variant playlist in one pass.
   *
   * DURATION — how long the single WebVTT "segment" must cover.
   * `video.duration` is null for every externally pre-transcoded bundle
   * (nothing ever probed those files), so rather than fall straight back to a
   * placeholder the real duration is recovered by summing the EXTINFs of the
   * first variant playlist, which sits next to the master and is
   * authoritative. Only if that fails too does the fallback apply.
   *
   * INITIAL PTS — where the presentation's clock actually starts, which is the
   * only correct value for the WebVTT `X-TIMESTAMP-MAP`. It has to be measured
   * rather than assumed: ffmpeg's mpegts muxer starts a VOD rendition at its
   * default mux delay (~1.4s / ~129 900 ticks), so the conventional 900000
   * would push every cue ~8.6s late. Zero — the value both hls.js and
   * AVFoundation assume in the tag's absence, and the truth for fMP4 — is the
   * fallback when the segment cannot be probed.
   */
  private async resolveTimeline(
    video: Video,
    master: string,
  ): Promise<PublishTimeline> {
    // 0 => buildSubtitleMediaPlaylist() substitutes its own fallback.
    let durationSeconds =
      video.duration && video.duration > 0 ? video.duration : 0;
    let initialPts = 0;

    try {
      const variantUri = firstVariantUri(master);
      if (variantUri && !/^https?:/i.test(variantUri)) {
        const variantKey = resolveRelativeKey(
          video.hlsMasterPath ?? '',
          variantUri,
        );
        const variant = await this.minioService.readText(variantKey);

        if (durationSeconds <= 0) {
          const total = totalDurationFromMediaPlaylist(variant);
          if (total && total > 0) durationSeconds = total;
        }

        const segmentUri = firstSegmentUri(variant);
        if (segmentUri && !/^https?:/i.test(segmentUri)) {
          const head = await this.minioService.readBytes(
            resolveRelativeKey(variantKey, segmentUri),
            PTS_PROBE_BYTES,
          );
          initialPts = initialPtsFromTransportStream(head) ?? 0;
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Could not read the media timeline for video ${video.id} from its variant playlist (${reason}) — using fallbacks`,
      );
    }

    return { durationSeconds, initialPts };
  }

  private noop(
    videoId: string,
    movieId: string | null,
    reason: string,
  ): SubtitlePublishResult {
    return {
      videoId,
      movieId,
      masterKey: null,
      masterUpdated: false,
      published: [],
      excluded: [],
      skipped: reason,
    };
  }
}
