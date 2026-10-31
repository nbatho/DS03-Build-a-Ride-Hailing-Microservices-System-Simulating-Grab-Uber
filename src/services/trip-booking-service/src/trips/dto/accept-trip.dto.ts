import { IsUUID } from 'class-validator';
import type { AcceptRequest } from '@app/contracts';

export class AcceptTripDto implements AcceptRequest {
  @IsUUID()
  offerId!: string;
}
