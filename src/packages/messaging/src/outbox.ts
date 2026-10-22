import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { EventValidationError, type RideEvent } from '@app/contracts';
import type { EventPublisher } from './event-publisher';
import { assertTableName } from './sql';

// Hàng chờ gửi (BA mục 8.2): ghi dòng nghiệp vụ + dòng outbox trong cùng transaction; relay gửi qua
// confirm channel có mandatory, chỉ đánh dấu PUBLISHED khi được xác nhận và không bị trả lại.
// Chết giữa lúc gửi và lúc đánh dấu thì có thể gửi lặp; bên nhận bỏ trùng theo event_id.

/**
 * Ghi sự kiện vào outbox bằng `manager` của transaction nghiệp vụ.
 * false nếu bị bỏ qua vì trùng khóa (cùng event_id, hoặc unique index riêng của service như "failed một lần").
 */
export async function enqueueOutboxEvent(
  manager: EntityManager,
  table: string,
  event: RideEvent,
): Promise<boolean> {
  const rows: unknown[] = await manager.query(
    'INSERT INTO ' +
      assertTableName(table) +
      ' (event_id, type, aggregate_id, aggregate_version, schema_version, correlation_id, causation_id, envelope_json)' +
      ' VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) ON CONFLICT DO NOTHING RETURNING event_id',
    [
      event.event_id,
      event.type,
      event.aggregate_id,
      event.aggregate_version,
      event.schema_version,
      event.correlation_id,
      event.causation_id,
      JSON.stringify(event),
    ],
  );

  return rows.length > 0;
}

export interface OutboxRelayOptions {
  /** Bảng đầy đủ schema, ví dụ "matching_schema.outbox_events". */
  table: string;
  batchSize?: number;
  pollIntervalMs?: number;
  /** Thời hạn nhận việc; hết hạn thì worker khác lấy lại dòng PUBLISHING. */
  leaseMs?: number;
  maxBackoffMs?: number;
}

interface ClaimedRow {
  event_id: string;
  envelope_json: unknown;
  attempts: number;
}

/** Worker gửi từ outbox; mỗi service tạo một relay với DataSource và bảng của chính nó. */
export class OutboxRelay {
  private readonly logger = new Logger('OutboxRelay');

  private readonly table: string;

  private readonly batchSize: number;

  private readonly pollIntervalMs: number;

  private readonly leaseMs: number;

  private readonly maxBackoffMs: number;

  private timer?: NodeJS.Timeout;

  private running?: Promise<unknown>;

  private stopped = true;

  constructor(
    private readonly dataSource: DataSource,
    private readonly publisher: Pick<EventPublisher, 'publish' | 'isReady'>,
    options: OutboxRelayOptions,
  ) {
    this.table = assertTableName(options.table);
    this.batchSize = options.batchSize ?? 20;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
  }

  start(): void {
    if (!this.stopped) {
      return;
    }

    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running?.catch(() => undefined);
  }

  /** Gửi một lô; trả về số sự kiện đã được xác nhận. */
  async dispatchOnce(): Promise<number> {
    if (!this.publisher.isReady()) {
      return 0;
    }

    const leaseToken = randomUUID();
    const rows: ClaimedRow[] = await this.dataSource.query(
      `WITH claimed AS (
         UPDATE ${this.table} AS o
            SET status = 'PUBLISHING', lease_token = $1, lease_until = now() + make_interval(secs => $2),
                attempts = o.attempts + 1
           FROM (SELECT event_id FROM ${this.table}
                  WHERE (status = 'PENDING' AND next_retry_at <= now())
                     OR (status = 'PUBLISHING' AND lease_until < now())
                  ORDER BY created_at, event_id
                  LIMIT $3
                  FOR UPDATE SKIP LOCKED) AS c
          WHERE o.event_id = c.event_id
      RETURNING o.event_id, o.envelope_json, o.attempts)
       SELECT event_id, envelope_json, attempts FROM claimed`,
      [leaseToken, this.leaseMs / 1000, this.batchSize],
    );
    let published = 0;

    // Gửi ngoài transaction, theo thứ tự tạo. Thứ tự vẫn có thể đảo khi gửi lại; bên nhận dựa vào phiên bản (BA mục 8.3).
    for (const row of rows) {
      try {
        await this.publisher.publish(row.envelope_json);
        await this.dataSource.query(
          `UPDATE ${this.table} SET status = 'PUBLISHED', published_at = now(), lease_token = NULL,
                  lease_until = NULL, last_error = NULL
            WHERE event_id = $1 AND lease_token = $2`,
          [row.event_id, leaseToken],
        );

        published += 1;
      } catch (error) {
        await this.markFailure(row, leaseToken, error);
      }
    }

    return published;
  }

  private async markFailure(row: ClaimedRow, leaseToken: string, error: unknown): Promise<void> {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);

    if (error instanceof EventValidationError) {
      // Envelope hỏng thì gửi lại cũng không được; để FAILED cho người vận hành xem.
      this.logger.error('Outbox event ' + row.event_id + ' is invalid: ' + message);
      await this.dataSource.query(
        `UPDATE ${this.table} SET status = 'FAILED', lease_token = NULL, lease_until = NULL, last_error = $3
          WHERE event_id = $1 AND lease_token = $2`,
        [row.event_id, leaseToken, message],
      );

      return;
    }

    const backoffMs = Math.min(this.maxBackoffMs, 1_000 * 2 ** Math.max(0, row.attempts - 1));

    this.logger.warn(
      'Outbox event ' + row.event_id + ' not published (attempt ' + row.attempts + '): ' + message,
    );

    await this.dataSource.query(
      `UPDATE ${this.table} SET status = 'PENDING', lease_token = NULL, lease_until = NULL, last_error = $3,
              next_retry_at = now() + make_interval(secs => $4)
        WHERE event_id = $1 AND lease_token = $2`,
      [row.event_id, leaseToken, message, backoffMs / 1000],
    );
  }

  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }

    this.timer = setTimeout(() => {
      const run = this.dispatchOnce().catch((error: unknown) => {
        this.logger.warn(
          'Outbox dispatch failed: ' + (error instanceof Error ? error.message : String(error)),
        );

        return 0;
      });

      this.running = run;
      void run.then(count => this.schedule(count >= this.batchSize ? 0 : this.pollIntervalMs));
    }, delayMs);
  }
}
