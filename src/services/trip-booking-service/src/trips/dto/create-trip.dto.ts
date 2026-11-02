import { IsUUID } from 'class-validator';
import type { CreateTripRequest } from '@app/contracts';

export class CreateTripDto implements CreateTripRequest {
  @IsUUID()
  quoteId!: string;
}
