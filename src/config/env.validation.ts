import { Type, plainToInstance } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

export enum Environment {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

class EnvironmentVariables {
  @IsOptional()
  @IsIn([Environment.Development, Environment.Production, Environment.Test])
  NODE_ENV: Environment = Environment.Development;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  PORT: number = 3001;

  @IsString()
  @MinLength(1)
  DATABASE_URL!: string;

  @IsString()
  @MinLength(16, { message: 'JWT_SECRET must be at least 16 characters' })
  JWT_SECRET!: string;

  @IsString()
  @MinLength(16, {
    message: 'JWT_REFRESH_SECRET must be at least 16 characters',
  })
  JWT_REFRESH_SECRET!: string;

  @IsOptional()
  @IsString()
  JWT_ACCESS_EXPIRES_IN: string = '15m';

  @IsOptional()
  @IsString()
  JWT_REFRESH_EXPIRES_IN: string = '7d';

  /**
   * OAuth 2.0 *Web* client ID from Google Cloud Console — the `aud` every
   * Google ID token must carry. Empty/unset disables "Continue with Google"
   * (POST /auth/google answers 503); nothing else in the app changes.
   */
  @IsOptional()
  @IsString()
  GOOGLE_CLIENT_ID?: string;

  /**
   * Client secret of that same OAuth Web client. Only the popup auth-code
   * flow (POST /auth/google with `code`) needs it — the backend exchanges
   * the code with Google server-side. Empty/unset leaves the ID-token
   * (`credential`) path working and makes the code path answer 503.
   */
  @IsOptional()
  @IsString()
  GOOGLE_CLIENT_SECRET?: string;

  @IsOptional()
  @IsString()
  STORAGE_PATH: string = './storage';

  @IsString()
  @MinLength(1)
  MINIO_ENDPOINT!: string;

  @IsString()
  @MinLength(1)
  MINIO_ACCESS_KEY!: string;

  @IsString()
  @MinLength(1)
  MINIO_SECRET_KEY!: string;

  @IsOptional()
  @IsString()
  MINIO_BUCKET: string = 'movies';

  @IsString()
  @MinLength(1)
  STREAM_PUBLIC_BASE_URL!: string;
}

export function validateEnv(
  config: Record<string, unknown>,
): EnvironmentVariables {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, { skipMissingProperties: false });

  if (errors.length > 0) {
    const messages = errors
      .map((error) => Object.values(error.constraints ?? {}).join(', '))
      .join('; ');
    throw new Error(`Invalid environment configuration: ${messages}`);
  }

  return validated;
}
