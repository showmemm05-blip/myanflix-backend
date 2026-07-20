import ffmpeg from 'fluent-ffmpeg';

export interface ProbeResult {
  durationSeconds: number;
  width: number;
  height: number;
}

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
      .videoCodec('libx264')
      .audioCodec('aac')
      .audioBitrate('128k')
      .outputOptions([
        `-vf scale=-2:${options.targetHeight}`,
        `-b:v ${options.videoBitrate}`,
        '-preset veryfast',
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
