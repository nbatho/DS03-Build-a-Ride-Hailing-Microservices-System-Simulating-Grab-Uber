import type { DataSource, EntityManager } from 'typeorm';
import type { RideEvent } from '@app/contracts';
import { runInTransaction, type TransactionOptions } from '@app/runtime';
import { assertTableName } from './sql';

// Bỏ trùng phía nhận (BA mục 8.2): trong cùng một transaction ghi "đã xử lý" theo (consumer_name, event_id),
// cập nhật nghiệp vụ, ghi sự kiện kết quả vào outbox. Bảng chuẩn: xem processedEventsTableDdl.

export interface InboxOptions {
  /** Bảng đầy đủ schema, ví dụ "matching_schema.processed_events". */
  table: string;
  /** Tên bên nhận, ví dụ "matching-service". */
  consumerName: string;
}

/** true nếu đây là lần đầu; false nếu (consumer_name, event_id) đã được ghi. */
export async function recordProcessedEvent(
  manager: EntityManager,
  options: InboxOptions,
  event: RideEvent,
): Promise<boolean> {
  const rows: unknown[] = await manager.query(
    'INSERT INTO ' +
      assertTableName(options.table) +
      ' (consumer_name, event_id, event_type, aggregate_id, aggregate_version, correlation_id)' +
      ' VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (consumer_name, event_id) DO NOTHING RETURNING event_id',
    [
      options.consumerName,
      event.event_id,
      event.type,
      event.aggregate_id,
      event.aggregate_version,
      event.correlation_id,
    ],
  );

  return rows.length > 0;
}

export type ProcessOnceResult<T> = { duplicate: true } | { duplicate: false; result: T };

/**
 * Chạy `work` đúng một lần cho mỗi event_id. Bản trùng trả về duplicate (consumer ACK luôn).
 * Lỗi trong `work` làm rollback cả dòng "đã xử lý" để lần sau còn xử lý được.
 * `work` có thể chạy lại khi deadlock nên chỉ được dùng `manager`, không gọi HTTP hay gửi RabbitMQ.
 */
export function processEventOnce<T>(
  dataSource: DataSource,
  options: InboxOptions,
  event: RideEvent,
  work: (manager: EntityManager) => Promise<T>,
  transaction?: TransactionOptions,
): Promise<ProcessOnceResult<T>> {
  return runInTransaction(
    dataSource,
    async manager => {
      if (!(await recordProcessedEvent(manager, options, event))) {
        return { duplicate: true } as const;
      }

      return { duplicate: false, result: await work(manager) } as const;
    },
    transaction,
  );
}
