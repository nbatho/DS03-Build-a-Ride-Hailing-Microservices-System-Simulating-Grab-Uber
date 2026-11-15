import { Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { EventPublisher, OutboxRelay } from '@app/messaging';
import { MATCHING_OUTBOX_TABLE } from './matching-state.service';

// Lô lớn hơn mặc định: lúc tải cao (P01) worker tạo nhiều offer cùng lúc; relay gửi tiếp ngay khi lô còn đầy.
const PUBLISH_BATCH = 50;

@Injectable()
export class MatchingOutboxRelay implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly relay: OutboxRelay;

  constructor(dataSource: DataSource, publisher: EventPublisher) {
    this.relay = new OutboxRelay(dataSource, publisher, {
      table: MATCHING_OUTBOX_TABLE,
      batchSize: PUBLISH_BATCH,
    });
  }

  onApplicationBootstrap(): void {
    this.relay.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.relay.stop();
  }
}
