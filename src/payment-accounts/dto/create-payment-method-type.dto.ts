import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ToBoolean } from '../../common/decorators/to-boolean.decorator';

export class CreatePaymentMethodTypeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  label!: string;

  /**
   * Create-time default is `?? false` in PaymentAccountsService.createType
   * (and Prisma `@default(false)`). No class initializer on purpose:
   * UpdatePaymentMethodTypeDto = PartialType(CreatePaymentMethodTypeDto)
   * inherits initializers and the global transform pipe (src/app.module.ts)
   * would inject `false` into every PATCH that omits the field. Precedent:
   * src/subscriptions/dto/create-plan.dto.ts.
   */
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  requiresBankName?: boolean;

  @IsOptional()
  @IsString()
  logoUrl?: string;
}
