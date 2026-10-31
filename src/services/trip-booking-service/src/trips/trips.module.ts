import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DriverClient } from './driver.client';
import { FareSnapshot } from './entities/fare-snapshot.entity';
import { Operation } from './entities/operation.entity';
import { SagaStep } from './entities/saga-step.entity';
import { StateHistory } from './entities/state-history.entity';
import { Trip } from './entities/trip.entity';
import { MatchingClient } from './matching.client';
import { OperationsController } from './operations.controller';
import { PricingClient } from './pricing.client';
import { SagaSteps } from './saga/saga-steps';
import { SagaStore } from './saga/saga.store';
import { SagaWorker } from './saga/saga.worker';
import { TripCommandsService } from './trip-commands.service';
import { TripEventsConsumer } from './trip-events.consumer';
import { TripOutboxRelay } from './trip-outbox.relay';
import { TripsInternalController } from './trips-internal.controller';
import { TripsController } from './trips.controller';
import { TripsService } from './trips.service';

@Module({
  imports: [TypeOrmModule.forFeature([Trip, FareSnapshot, StateHistory, Operation, SagaStep])],
  controllers: [TripsController, OperationsController, TripsInternalController],
  providers: [
    PricingClient,
    MatchingClient,
    DriverClient,
    TripsService,
    TripCommandsService,
    TripEventsConsumer,
    TripOutboxRelay,
    SagaStore,
    SagaSteps,
    SagaWorker,
  ],
})
export class TripsModule {}
