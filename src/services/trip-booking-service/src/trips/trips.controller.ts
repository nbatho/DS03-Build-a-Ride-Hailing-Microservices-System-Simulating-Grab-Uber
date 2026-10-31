import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { CurrentUser, Roles } from '@app/auth';
import type { Actor, Operation, Trip, TripsPage } from '@app/contracts';
import { IdempotencyKey, uuidParam, type ContextRequest } from '@app/runtime';
import { AcceptTripDto } from './dto/accept-trip.dto';
import { CreateTripDto } from './dto/create-trip.dto';
import { EmptyRequestDto } from './dto/empty-request.dto';
import { ListTripsQueryDto } from './dto/list-trips.query.dto';
import { RejectTripDto } from './dto/reject-trip.dto';
import { TripCommandsService } from './trip-commands.service';
import { TripsService } from './trips.service';

@Controller('trips')
export class TripsController {
  constructor(
    private readonly trips: TripsService,
    private readonly commands: TripCommandsService,
  ) {}

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

  @Post(':tripId/accept')
  @Roles('DRIVER')
  @HttpCode(202)
  accept(
    @CurrentUser() actor: Actor,
    @Param('tripId', uuidParam('tripId')) tripId: string,
    @Body() dto: AcceptTripDto,
    @IdempotencyKey() idempotencyKey: string,
    @Req() req: ContextRequest,
  ): Promise<Operation> {
    return this.commands.accept(actor, tripId.toLowerCase(), dto, idempotencyKey, req.correlationId);
  }

  @Post(':tripId/reject')
  @Roles('DRIVER')
  @HttpCode(202)
  reject(
    @CurrentUser() actor: Actor,
    @Param('tripId', uuidParam('tripId')) tripId: string,
    @Body() dto: RejectTripDto,
    @IdempotencyKey() idempotencyKey: string,
    @Req() req: ContextRequest,
  ): Promise<Operation> {
    return this.commands.reject(actor, tripId.toLowerCase(), dto, idempotencyKey, req.correlationId);
  }

  @Post(':tripId/start')
  @Roles('DRIVER')
  @HttpCode(200)
  start(
    @CurrentUser() actor: Actor,
    @Param('tripId', uuidParam('tripId')) tripId: string,
    @Body() _body: EmptyRequestDto,
    @IdempotencyKey() idempotencyKey: string,
    @Req() req: ContextRequest,
  ): Promise<Trip> {
    return this.commands.start(actor, tripId.toLowerCase(), idempotencyKey, req.correlationId);
  }

  @Post(':tripId/complete')
  @Roles('DRIVER')
  @HttpCode(202)
  complete(
    @CurrentUser() actor: Actor,
    @Param('tripId', uuidParam('tripId')) tripId: string,
    @Body() _body: EmptyRequestDto,
    @IdempotencyKey() idempotencyKey: string,
    @Req() req: ContextRequest,
  ): Promise<Operation> {
    return this.commands.complete(actor, tripId.toLowerCase(), idempotencyKey, req.correlationId);
  }
}
