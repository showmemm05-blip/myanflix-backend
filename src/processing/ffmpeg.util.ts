import ffmpeg from 'fluent-ffmpeg';

export interface ProbeResult {
  durationSeconds: number;
  width: number;
  height: number;
}

// Transcoding shares the Flokinet VPS with the API, admin, website, and
// Postgres — these keep it from starving everything else:
//   - FFMPEG_NICENESS: OS scheduling priority (-20 highest, 20 lowest). Near
//     the lowest means the API wins CPU time whenever both actually want it
//     at the same moment; costs ~nothing when the CPU isn't contended.
//   - FFMPEG_MAX_THREADS: hard ceiling on cores a single transcode can use,
//     so it can't claim all of them even briefly — always leaves headroom
//     for everything else, at the cost of some transcode speed.
const FFMPEG_NICENESS = 19;
const FFMPEG_MAX_THREADS = 6;

export function probeVideo(inputPath: string): Promise<ProbeResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    ffmpeg.ffprobe(inputPath, (err, data) => {
      if (err) return rejectPromise(err);

      const videoStream = data.streams.find((s) => s.codec_type === 'video');
      if (!videoStream)
        return rejectPromise(
          new Error('No video stream found in uploaded file'),
        );

      resolvePromise({
        durationSeconds: Math.round(data.format.duration ?? 0),
        width: videoStream.width ?? 0,
        height: videoStream.height ?? 0,
      });
    });
  });
}

export function transcodeToHls(options: {
  inputPath: string;
  outputDir: string;
  segmentPattern: string;
  playlistPath: string;
  targetHeight: number;
  videoBitrate: string;
}): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    ffmpeg(options.inputPath)
      .renice(FFMPEG_NICENESS)
      .videoCodec('libx264')
      .audioCodec('aac')
      .audioBitrate('128k')
      .outputOptions([
        `-vf scale=-2:${options.targetHeight}`,
        `-b:v ${options.videoBitrate}`,
        '-preset veryfast',
        `-threads ${FFMPEG_MAX_THREADS}`,
        '-sc_threshold 0',
        '-g 48',
        '-hls_time 6',
        '-hls_playlist_type vod',
        `-hls_segment_filename ${options.segmentPattern}`,
      ])
      .output(options.playlistPath)
      .on('error', (err) => rejectPromise(err))
      .on('end', () => resolvePromise())
      .run();
  });
}
