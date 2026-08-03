import { Transform } from 'class-transformer';
import { IsString, Matches } from 'class-validator';
import { normalizePhone } from '../../common/utils/phone.util';

export class CheckPhoneDto {
  @Transform(({ value }) => (typeof value === 'string' ? normalizePhone(value) : value))
  @IsString()
  @Matches(/^\+95\d{7,10}$/, { message: 'Enter a valid Myanmar phone number' })
  phone!: string;
}
