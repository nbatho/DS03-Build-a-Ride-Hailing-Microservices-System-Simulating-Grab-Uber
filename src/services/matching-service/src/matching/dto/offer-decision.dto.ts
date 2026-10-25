import { Transform } from 'class-transformer';
import { IsIn, IsUUID } from 'class-validator';
import { OFFER_DECISION_ACTIONS, type OfferDecisionAction } from '@app/contracts';
import { normalizeUuid } from './cancel-matching-job.dto';

export class OfferDecisionDto {
  @Transform(normalizeUuid)
  @IsUUID()
  assignmentId!: string;

  @Transform(normalizeUuid)
  @IsUUID()
  tripId!: string;

  @Transform(normalizeUuid)
  @IsUUID()
  driverId!: string;

  @IsIn(OFFER_DECISION_ACTIONS)
  action!: OfferDecisionAction;
}
