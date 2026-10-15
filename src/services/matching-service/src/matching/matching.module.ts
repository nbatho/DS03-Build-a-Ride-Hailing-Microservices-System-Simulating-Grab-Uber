import { Module } from '@nestjs/common';
import { MatchingController } from './matching.controller';
import { OffersInternalController } from './offers-internal.controller';
import { MatchingService } from './matching.service';
import { OffersService } from './offers.service';
import { MatchingWorker } from './matching.worker';
import { MatchingEventsConsumer } from './matching-events.consumer';
import { MatchingOutboxPublisher } from './matching-outbox.publisher';
import { DriverClient } from './driver.client';
import { TripClient } from './trip.client';

// TODO: DB matching_schema, internal guard, broker primitive của C, HTTP config, readiness và shutdown.

@Module({
  controllers: [MatchingController, OffersInternalController],
  providers: [MatchingService, OffersService, MatchingWorker, MatchingEventsConsumer, MatchingOutboxPublisher, DriverClient, TripClient],
})
export class MatchingModule {}
