import { Injectable, type OnModuleInit } from '@nestjs/common';
import { EVENT_QUEUES } from '@app/contracts';
import { EventConsumer } from '@app/messaging';
import { TripPaymentsService } from './trip-payments.service';
import { TripsService } from './trips.service';

@Injectable()
export class TripEventsConsumer implements OnModuleInit {
  constructor(
    private readonly consumer: EventConsumer,
    private readonly trips: TripsService,
    private readonly payments: TripPaymentsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.consumer.subscribe(EVENT_QUEUES.TRIP, {
      'matching.failed': event => this.trips.handleMatchingFailed(event),
      'payment.succeeded': event => this.payments.handlePaymentSucceeded(event),
      'payment.failed': event => this.payments.handlePaymentFailed(event),
    });
  }
}
