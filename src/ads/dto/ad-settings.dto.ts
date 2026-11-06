import { AdvertisementAudience } from '../../generated/prisma/client';
import { IsBoolean, IsEnum, IsInt, Max, Min } from 'class-validator';

/** The rules' bounds. Mirrored by CHECKs on the table. */
export const AD_SETTINGS_LIMITS = {
  /** 0 = no breaks; 1 minute is allowed so a break can be tried out quickly. */
  midrollIntervalMinutes: { min: 0, max: 240 },
} as const;

/** Used until the first save creates the row. */
export const AD_SETTINGS_DEFAULTS = {
  adsEnabled: true,
  midrollIntervalMinutes: 0,
  duringMovieAudience: AdvertisementAudience.ALL,
} as const;

/**
 * PUT /ads/admin/settings — the whole playback-rules row, replaced. Every
 * field is required: a PUT that forgot one would silently reset it.
 */
export class UpdateAdSettingsDto {
  /** The master switch: false = no ads of any kind, anywhere. */
  @IsBoolean()
  adsEnabled!: boolean;

  /** A mid-roll break every this many minutes of movie time; 0 = no breaks. */
  @IsInt()
  @Min(AD_SETTINGS_LIMITS.midrollIntervalMinutes.min)
  @Max(AD_SETTINGS_LIMITS.midrollIntervalMinutes.max)
  midrollIntervalMinutes!: number;

  /** Who gets the breaks and the corner pictures (the ad before the movie plays for everyone). */
  @IsEnum(AdvertisementAudience)
  duringMovieAudience!: AdvertisementAudience;
}
