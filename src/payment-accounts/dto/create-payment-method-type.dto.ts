import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreatePaymentMethodTypeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  label!: string;

  @IsOptional()
  @IsBoolean()
  requiresBankName?: boolean = false;

  @IsOptional()
  @IsString()
  logoUrl?: string;
}
