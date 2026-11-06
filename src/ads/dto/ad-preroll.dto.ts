import {
  IsDivisibleBy,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

/**
 * The player's playback events, in the order a play can report them.
 * `shown` (it came back) and `clicked` (its link was tapped) are the corner
 * picture's; a corner never sends `completed`, and its `skipped` is the ✕.
 */
export const AD_PLAYBACK_EVENTS = [
  'started',
  'completed',
  'skipped',
  'failed',
  'shown',
  'clicked',
] as const;
export type AdPlaybackEvent = (typeof AD_PLAYBACK_EVENTS)[number];

/** POST /ads/preroll and POST /ads/session — which title is about to play. */
export class PrerollRequestDto {
  @IsUUID('all')
  movieId!: string;
}

/** The movie seconds a break may sit at: whole minutes, from 1:00 to a day. */
export const BREAK_AT_LIMITS = { min: 60, max: 86_400, step: 60 } as const;

/**
 * POST /ads/midroll — the break the player is about to reach (or jumped
 * over). The server never checks it against the CURRENT interval: a viewer
 * keeps the breaks of the plan they opened with.
 */
export class MidrollRequestDto {
  @IsUUID('all')
  movieId!: string;

  @IsInt()
  @Min(BREAK_AT_LIMITS.min)
  @Max(BREAK_AT_LIMITS.max)
  @IsDivisibleBy(BREAK_AT_LIMITS.step)
  breakAtSeconds!: number;
}

/**
 * POST /ads/playbacks/:playbackId/events. `positionSeconds` is where the
 * player was when it skipped or failed — for a corner picture, how long the
 * showing had been up (a day is far past anything real, so the cap only
 * stops a nonsense number).
 */
export class AdPlaybackEventDto {
  @IsIn(AD_PLAYBACK_EVENTS)
  event!: AdPlaybackEvent;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(86_400)
  positionSeconds?: number;
}
