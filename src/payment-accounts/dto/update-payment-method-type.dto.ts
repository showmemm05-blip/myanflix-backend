import { PartialType } from '@nestjs/mapped-types';
import { CreatePaymentMethodTypeDto } from './create-payment-method-type.dto';

export class UpdatePaymentMethodTypeDto extends PartialType(
  CreatePaymentMethodTypeDto,
) {}
