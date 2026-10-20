import { setTimeout as sleep } from 'node:timers/promises';
import type { DataSource, EntityManager } from 'typeorm';
import type { IsolationLevel } from 'typeorm/driver/types/IsolationLevel';
import { ApiError } from './api-error';

// 40001 serialization_failure, 40P01 deadlock_detected: PostgreSQL hủy transaction để gỡ tranh chấp, chạy lại là an toàn.
const RETRYABLE_CODES = new Set(['40001', '40P01']);
const DEFAULT_MAX_ATTEMPTS = 3;

export interface TransactionOptions {
  isolation?: IsolationLevel;
  /** Tổng số lần chạy, kể cả lần đầu. */
  maxAttempts?: number;
}

export function isRetryableTransactionError(error: unknown): boolean {
  const failure = error as { code?: string; driverError?: { code?: string } } | undefined;
  return RETRYABLE_CODES.has(failure?.driverError?.code ?? failure?.code ?? '');
}

/**
 * Chạy `work` trong một transaction; bị deadlock/serialization thì chạy lại cả transaction (mặc định tối đa 3 lần).
 * `work` có thể chạy nhiều lần nên chỉ được đọc/ghi DB qua `manager`: không gọi HTTP, không gửi RabbitMQ bên trong.
 */
export async function runInTransaction<T>(
  dataSource: DataSource,
  work: (manager: EntityManager) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  for (let attempt = 1; ; attempt++) {
    try {
      return await dataSource.transaction(options.isolation ?? 'READ COMMITTED', work);
    } catch (error) {
      if (!isRetryableTransactionError(error)) throw error;
      if (attempt >= maxAttempts) {
        // 503 để bên gọi thử lại bằng cùng key/mã lệnh; không ghi gì vì transaction đã rollback.
        throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE', 'Database is busy, retry the same request');
      }
      await sleep(50 * attempt + Math.floor(Math.random() * 50));
    }
  }
}
