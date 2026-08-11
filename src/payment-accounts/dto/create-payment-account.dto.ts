import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreatePaymentAccountDto {
  /**
   * Not validated against a fixed list of known values — it must equal
   * some PaymentMethodType.label, but that catalog is admin-managed data,
   * not code, so it isn't practical (or safe under concurrent edits) to
   * enforce here at the DTO layer.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  type!: string;

  @IsString()
  @IsNotEmpty()
  accountName!: string;

  /** Account number or phone number, depending on type. */
  @IsString()
  @IsNotEmpty()
  accountNumber!: string;

  /** Only meaningful for bank-transfer types — the admin UI shows/requires
   * this conditionally based on the selected type's `requiresBankName`
   * metadata; left optional here since that's UI guidance, not a hard rule
   * tied to any one specific type value. */
  @IsOptional()
  @IsString()
  bankName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean = true;
}
