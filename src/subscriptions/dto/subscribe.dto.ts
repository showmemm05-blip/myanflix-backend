import { IsUUID } from 'class-validator';

export class SubscribeDto {
  @IsUUID('4')
  planId!: string;
}
