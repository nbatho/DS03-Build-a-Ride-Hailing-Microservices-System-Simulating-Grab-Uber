import { IsIn, IsUUID } from 'class-validator';
import { REJECT_REASONS, type RejectReason, type RejectRequest } from '@app/contracts';

export class RejectTripDto implements RejectRequest {
  @IsUUID()
  offerId!: string;

  @IsIn(REJECT_REASONS)
  reason!: RejectReason;
}
