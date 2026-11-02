import { Transform } from 'class-transformer';
import { IsIn, IsUUID } from 'class-validator';
import { OFFER_RESOLUTION_RESULTS, type OfferResolutionResult } from '@app/contracts';
import { normalizeUuid } from './cancel-matching-job.dto';

export class OfferResolutionDto {
  @Transform(normalizeUuid)
  @IsUUID()
  commandId!: string;

  @Transform(normalizeUuid)
  @IsUUID()
  assignmentId!: string;

  @Transform(normalizeUuid)
  @IsUUID()
  tripId!: string;

  @IsIn(OFFER_RESOLUTION_RESULTS)
  result!: OfferResolutionResult;
}
