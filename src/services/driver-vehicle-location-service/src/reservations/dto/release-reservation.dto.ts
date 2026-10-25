import { IsIn } from 'class-validator';
import { RELEASE_REASONS, type ReleaseReason } from '@app/contracts';
import { ConfirmReservationDto } from './confirm-reservation.dto';

export class ReleaseReservationDto extends ConfirmReservationDto {
  @IsIn(RELEASE_REASONS)
  reason!: ReleaseReason;
}
