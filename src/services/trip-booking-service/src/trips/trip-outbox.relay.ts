import { Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { EventPublisher, OutboxRelay } from '@app/messaging';
import { TRIP_OUTBOX_TABLE } from './trip-tables';

@Injectable()
export class TripOutboxRelay implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly relay: OutboxRelay;

  constructor(dataSource: DataSource, publisher: EventPublisher) {
    this.relay = new OutboxRelay(dataSource, publisher, { table: TRIP_OUTBOX_TABLE });
  }

  onApplicationBootstrap(): void {
    this.relay.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.relay.stop();
  }
}
