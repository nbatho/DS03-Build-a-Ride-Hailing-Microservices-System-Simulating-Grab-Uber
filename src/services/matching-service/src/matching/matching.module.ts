import { Module } from '@nestjs/common';
import { MatchingController } from './matching.controller';
import { OffersInternalController } from './offers-internal.controller';
import { MatchingService } from './matching.service';
import { OffersService } from './offers.service';
import { MatchingWorker } from './matching.worker';
import { MatchingEventsConsumer } from './matching-events.consumer';
import { MatchingOutboxRelay } from './matching-outbox.relay';
import { DriverClient } from './driver.client';
import { TripClient } from './trip.client';
import { MatchingStateService } from './matching-state.service';

@Module({
  controllers: [MatchingController, OffersInternalController],
  providers: [
    MatchingService,
    OffersService,
    MatchingWorker,
    MatchingEventsConsumer,
    MatchingOutboxRelay,
    DriverClient,
    TripClient,
    MatchingStateService,
  ],
})
export class MatchingModule {}
