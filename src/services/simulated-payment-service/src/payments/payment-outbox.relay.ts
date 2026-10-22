import { Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { EventPublisher, OutboxRelay } from '@app/messaging';
import { PAYMENT_OUTBOX_TABLE } from './payments.service';

// Gửi payment.succeeded/failed từ payment_schema.outbox_events lên ride.events.
@Injectable()
export class PaymentOutboxRelay implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly relay: OutboxRelay;

  constructor(dataSource: DataSource, publisher: EventPublisher) {
    this.relay = new OutboxRelay(dataSource, publisher, { table: PAYMENT_OUTBOX_TABLE });
  }

  onApplicationBootstrap(): void {
    this.relay.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.relay.stop();
  }
}
