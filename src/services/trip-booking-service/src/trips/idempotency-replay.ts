import type { DataSource } from 'typeorm';
import { ApiError, requestFingerprint, type IdempotencyKeyScope } from '@app/runtime';

export async function findCompletedResponse<T>(
  database: DataSource,
  scope: IdempotencyKeyScope,
  request: unknown,
): Promise<T | null> {
  const [row] = (await database.query(
    `SELECT request_hash, response_body FROM ${scope.schema}.idempotency_keys
      WHERE actor_id = $1 AND method = $2 AND path = $3 AND key = $4 AND status = 'COMPLETED'`,
    [scope.actorId, scope.method.toUpperCase(), scope.path, scope.key],
  )) as Array<{ request_hash: string; response_body: T }>;

  if (!row) {
    return null;
  }

  if (row.request_hash !== requestFingerprint(request)) {
    throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This key was already used with a different request');
  }

  return row.response_body;
}
