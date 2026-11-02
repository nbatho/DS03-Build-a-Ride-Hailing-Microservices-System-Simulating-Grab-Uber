import { Controller, Get, Param } from '@nestjs/common';
import type { Trip } from '@app/contracts';
import { InternalRoute, uuidParam } from '@app/runtime';
import { TripsService } from './trips.service';

@InternalRoute('MATCHING', 'DRIVER', 'PAYMENT')
@Controller('internal/v1/trips')
export class TripsInternalController {
  constructor(private readonly trips: TripsService) {}

  @Get(':tripId')
  getOne(@Param('tripId', uuidParam('tripId')) tripId: string): Promise<Trip> {
    return this.trips.getTripForService(tripId);
  }
}
