import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { runInTransaction } from '@app/runtime';
import { MatchingBroker, MATCHING_EXCHANGE } from './matching-broker';
import { MatchingStateService } from './matching-state.service';
import { OutboxEventEntity } from './entities/outbox-event.entity';

// Gửi tối đa PUBLISH_BATCH sự kiện mỗi lượt; còn sự kiện chờ thì gửi tiếp ngay (tới TICK_BUDGET_MS) thay vì chờ 500 ms.
const PUBLISH_BATCH = 50;
const TICK_BUDGET_MS = 2000;

@Injectable()
export class MatchingOutboxPublisher implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;

  constructor(
    private readonly database: DataSource,
    private readonly broker: MatchingBroker,
    private readonly state: MatchingStateService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      if (!this.running && this.broker.isReady()) {
        this.running = this.drain()
          .catch(() => Logger.warn('Matching outbox failed; will retry', 'MatchingOutbox'))
          .finally(() => {
            this.running = undefined;
          });
      }
    }, 500);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }

  private async drain(): Promise<void> {
    const until = Date.now() + TICK_BUDGET_MS;
    let published: number;

    do {
      published = await this.publishPendingEvents();
    } while (published === PUBLISH_BATCH && Date.now() < until && this.broker.isReady());
  }

  /** Trả về số sự kiện đã nhận gửi trong lượt này. */
  async publishPendingEvents(): Promise<number> {
    const claims = await runInTransaction(this.database, async manager => {
      const rows = await manager
        .getRepository(OutboxEventEntity)
        .createQueryBuilder('event')
        .where(
          "(event.status='PENDING' AND event.next_retry_at <= clock_timestamp()) OR (event.status='PUBLISHING' AND event.lease_until <= clock_timestamp())",
        )
        .orderBy('event.created_at', 'ASC')
        .addOrderBy('event.event_id', 'ASC')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .take(PUBLISH_BATCH)
        .getMany();
      const now = await this.state.now(manager);

      for (const event of rows) {
        event.status = 'PUBLISHING';
        event.attempts++;
        event.leaseToken = randomUUID();
        event.leaseUntil = new Date(now.getTime() + 15000);
        await manager.getRepository(OutboxEventEntity).save(event);
      }

      return rows;
    });

    await Promise.allSettled(
      claims.map(async event => {
        try {
          await this.broker.publish(
            MATCHING_EXCHANGE,
            event.type,
            Buffer.from(JSON.stringify(event.envelopeJson)),
            {
              messageId: event.eventId,
              correlationId: event.correlationId,
              contentType: 'application/json',
            },
          );
          await this.database.query(
            `UPDATE matching_schema.outbox_events
          SET status='PUBLISHED', published_at=clock_timestamp(), lease_token=NULL, lease_until=NULL, last_error=NULL
          WHERE event_id=$1 AND status='PUBLISHING' AND lease_token=$2`,
            [event.eventId, event.leaseToken],
          );
        } catch {
          await this.database.query(
            `UPDATE matching_schema.outbox_events SET status='PENDING',
          lease_token=NULL, lease_until=NULL, last_error='BROKER_PUBLISH_FAILED',
          next_retry_at=clock_timestamp()+$3 * interval '1 second'
          WHERE event_id=$1 AND status='PUBLISHING' AND lease_token=$2`,
            [event.eventId, event.leaseToken, Math.min(30, 2 ** Math.min(event.attempts, 5))],
          );
        }
      }),
    );

    return claims.length;
  }
}
