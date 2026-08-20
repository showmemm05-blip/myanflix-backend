import { IsEnum } from 'class-validator';
import { SeriesStatus } from '../../generated/prisma/client';

/** Body of PATCH /series/:id/status — one route handles publish AND unpublish. */
export class UpdateSeriesStatusDto {
  @IsEnum(SeriesStatus)
  status!: SeriesStatus;
}
