import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { ToBoolean } from '../../common/decorators/to-boolean.decorator';
import { OptionalHttpUrl } from './home-promo.dto';

export const HOME_SETTINGS_LIMITS = {
  url: 500,
  gamesTeaserDateText: 40,
} as const;

/**
 * PUT /home/settings — the whole settings row, replaced. A link that is
 * omitted, null or blank is stored as NULL, which every app reads as "not
 * set": the card or store badge that needs it simply does not render.
 * `gamesTeaserEnabled` is the one field that must always be sent.
 */
export class UpdateHomeSettingsDto {
  /** The website address shown on the app's "Also on the web" card. */
  @OptionalHttpUrl(HOME_SETTINGS_LIMITS.url)
  webUrl?: string | null;

  @OptionalHttpUrl(HOME_SETTINGS_LIMITS.url)
  appStoreUrl?: string | null;

  @OptionalHttpUrl(HOME_SETTINGS_LIMITS.url)
  playStoreUrl?: string | null;

  @ToBoolean()
  @IsBoolean()
  gamesTeaserEnabled!: boolean;

  /** Free text such as "2027"; null = the teaser says only "Coming soon". */
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const text = value.trim();
    return text === '' ? null : text;
  })
  @IsOptional()
  @IsString()
  @MaxLength(HOME_SETTINGS_LIMITS.gamesTeaserDateText)
  gamesTeaserDateText?: string | null;
}
