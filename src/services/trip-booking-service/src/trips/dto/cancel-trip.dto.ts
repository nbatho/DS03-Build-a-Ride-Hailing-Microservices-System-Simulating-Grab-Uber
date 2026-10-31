import { IsIn } from 'class-validator';
import { TRIP_CANCEL_REASONS, type CancelRequest, type TripCancelReason } from '@app/contracts';

export class CancelTripDto implements CancelRequest {
  @IsIn(TRIP_CANCEL_REASONS)
  reason!: TripCancelReason;
}
