import { Transform } from 'class-transformer';
import { IsUUID } from 'class-validator';
import { normalizeUuid } from './reserve-reservation.dto';

export class ConfirmReservationDto {
  @Transform(normalizeUuid)
  @IsUUID()
  commandId!: string;

  @Transform(normalizeUuid)
  @IsUUID()
  tripId!: string;

  @Transform(normalizeUuid)
  @IsUUID()
  driverId!: string;
}
