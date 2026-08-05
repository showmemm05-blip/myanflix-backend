import {
  ArrayMinSize,
  IsArray,
  IsString,
  Matches,
  MinLength,
} from 'class-validator';

export class ValidateExternalBundleDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @Matches(/^(?!\/)(?!.*\.\.)[\w\-./]+$/, {
    each: true,
    message: 'each relativePath must be a relative path with no ".." segments',
  })
  relativePaths!: string[];
}
