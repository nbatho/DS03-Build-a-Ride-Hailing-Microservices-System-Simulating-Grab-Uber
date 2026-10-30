import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FareSnapshot } from './entities/fare-snapshot.entity';
import { Operation } from './entities/operation.entity';
import { StateHistory } from './entities/state-history.entity';
import { Trip } from './entities/trip.entity';
import { MatchingClient } from './matching.client';
import { OperationsController } from './operations.controller';
import { PricingClient } from './pricing.client';
import { TripEventsConsumer } from './trip-events.consumer';
import { TripOutboxRelay } from './trip-outbox.relay';
import { TripsInternalController } from './trips-internal.controller';
import { TripsController } from './trips.controller';
import { TripsService } from './trips.service';

@Module({
  imports: [TypeOrmModule.forFeature([Trip, FareSnapshot, StateHistory, Operation])],
  controllers: [TripsController, OperationsController, TripsInternalController],
  providers: [PricingClient, MatchingClient, TripsService, TripEventsConsumer, TripOutboxRelay],
})
export class TripsModule {}
