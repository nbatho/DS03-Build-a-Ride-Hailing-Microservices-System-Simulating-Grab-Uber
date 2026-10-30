import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { CurrentUser, Roles } from '@app/auth';
import type { Actor, Trip, TripsPage } from '@app/contracts';
import { IdempotencyKey, uuidParam, type ContextRequest } from '@app/runtime';
import { CreateTripDto } from './dto/create-trip.dto';
import { ListTripsQueryDto } from './dto/list-trips.query.dto';
import { TripsService } from './trips.service';

@Controller('trips')
export class TripsController {
  constructor(private readonly trips: TripsService) {}

  @Post()
  @Roles('PASSENGER')
  create(
    @CurrentUser() actor: Actor,
    @Body() dto: CreateTripDto,
    @IdempotencyKey() idempotencyKey: string,
    @Req() req: ContextRequest,
  ): Promise<Trip> {
    return this.trips.createTrip(actor.userId, dto, idempotencyKey, req.correlationId);
  }

  @Get()
  @Roles('PASSENGER', 'DRIVER')
  list(@CurrentUser() actor: Actor, @Query() query: ListTripsQueryDto): Promise<TripsPage> {
    return this.trips.listTrips(actor, query);
  }

  @Get(':tripId')
  @Roles('PASSENGER', 'DRIVER')
  getOne(@CurrentUser() actor: Actor, @Param('tripId', uuidParam('tripId')) tripId: string): Promise<Trip> {
    return this.trips.getTrip(actor, tripId);
  }
}
