import { Transform } from 'class-transformer';
import { IsUUID } from 'class-validator';

export const normalizeUuid = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.toLowerCase() : value;

export class ReserveReservationDto {
  @Transform(normalizeUuid)
  @IsUUID()
  tripId!: string;

  @Transform(normalizeUuid)
  @IsUUID()
  driverId!: string;

  @Transform(normalizeUuid)
  @IsUUID()
  offerId!: string;
}
