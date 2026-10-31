import { createHash } from 'node:crypto';
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { DataSource, EntityManager } from 'typeorm';
import type { InternalCaller } from '@app/shared-types';
import { ApiError } from './api-error';
import type { ContextRequest } from './http-context';
import { runInTransaction, type TransactionOptions } from './transaction';

const KEY_TTL = '24 hours';
const SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/;

export interface StoredResponse<T> { status: number; body: T }
export interface IdempotentResult<T> extends StoredResponse<T> { replayed: boolean }

export interface IdempotencyKeyScope {
  schema: string;
  actorId: string;
  method: string;
  path: string;
  key: string;
}

export interface CommandScope {
  schema: string;
  callerService: InternalCaller;
  commandType: string;
  commandId: string;
  resourceId: string;
  correlationId: string;
}

type Handler<T> = (manager: EntityManager) => Promise<StoredResponse<T>>;

function canonical(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(item => canonical(item ?? null)).join(',') + ']';
  const record = value as Record<string, unknown>;
  return '{' + Object.keys(record).filter(key => record[key] !== undefined).sort()
    .map(key => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}';
}

export function requestFingerprint(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export const IdempotencyKey = createParamDecorator((_data: unknown, context: ExecutionContext): string => {
  const value = context.switchToHttp().getRequest<ContextRequest>().headers['idempotency-key'];
  if (typeof value !== 'string' || !isUUID(value)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Idempotency-Key header must be a UUID');
  }
  return value.toLowerCase();
});

function table(schema: string, name: string): string {
  if (!SCHEMA_NAME.test(schema)) throw new Error('Invalid schema name: ' + schema);
  return schema + '.' + name;
}

interface ClaimSql { insert: string; insertParams: unknown[]; select: string; complete: string; keyParams: unknown[] }

async function claimOrReplay<T>(
  manager: EntityManager, sql: ClaimSql, hash: string, conflictCode: string, handler: Handler<T>,
): Promise<IdempotentResult<T>> {
  const claimed: unknown[] = await manager.query(sql.insert, sql.insertParams);
  if (claimed.length) {
    const result = await handler(manager);

    const body = JSON.parse(JSON.stringify(result.body ?? null)) as T;
    await manager.query(sql.complete, [...sql.keyParams, result.status, JSON.stringify(body)]);
    return { status: result.status, body, replayed: false };
  }
  const [row] = await manager.query(sql.select, sql.keyParams) as Array<{
    request_hash: string; status: string; response_status: number | null; response_body: T;
  }>;
  if (row && row.request_hash !== hash) {
    throw new ApiError(409, conflictCode, 'This key was already used with a different request');
  }
  if (!row || row.status !== 'COMPLETED' || row.response_status === null) {
    throw new ApiError(409, conflictCode, 'A request with this key is still in progress; retry later with the same key');
  }
  return { status: row.response_status, body: row.response_body, replayed: true };
}

export function withIdempotencyKey<T>(
  dataSource: DataSource, scope: IdempotencyKeyScope, request: unknown, handler: Handler<T>, options?: TransactionOptions,
): Promise<IdempotentResult<T>> {
  const name = table(scope.schema, 'idempotency_keys');
  const hash = requestFingerprint(request);
  const keyParams = [scope.actorId, scope.method.toUpperCase(), scope.path, scope.key];
  const where = 'actor_id = $1 AND method = $2 AND path = $3 AND key = $4';
  return runInTransaction(dataSource, manager => claimOrReplay(manager, {
    insert: `INSERT INTO ${name} (actor_id, method, path, key, request_hash, expires_at)
      VALUES ($1, $2, $3, $4, $5, now() + $6::interval) ON CONFLICT DO NOTHING RETURNING key`,
    insertParams: [...keyParams, hash, KEY_TTL],
    select: `SELECT request_hash, status, response_status, response_body FROM ${name} WHERE ${where}`,
    complete: `UPDATE ${name} SET status = 'COMPLETED', response_status = $5, response_body = $6 WHERE ${where}`,
    keyParams,
  }, hash, 'IDEMPOTENCY_CONFLICT', handler), options);
}

export function withCommandResult<T>(
  dataSource: DataSource, scope: CommandScope, request: unknown, handler: Handler<T>, options?: TransactionOptions,
): Promise<IdempotentResult<T>> {
  const name = table(scope.schema, 'command_results');
  const hash = requestFingerprint({ resourceId: scope.resourceId, request });
  const keyParams = [scope.callerService, scope.commandType, scope.commandId];
  const where = 'caller_service = $1 AND command_type = $2 AND command_id = $3';
  return runInTransaction(dataSource, manager => claimOrReplay(manager, {
    insert: `INSERT INTO ${name} (caller_service, command_type, command_id, resource_id, request_hash, status, correlation_id)
      VALUES ($1, $2, $3, $4, $5, 'IN_PROGRESS', $6) ON CONFLICT DO NOTHING RETURNING command_id`,
    insertParams: [...keyParams, scope.resourceId, hash, scope.correlationId],
    select: `SELECT request_hash, status, response_status, response_body FROM ${name} WHERE ${where}`,
    complete: `UPDATE ${name} SET status = 'COMPLETED', response_status = $4, response_body = $5, updated_at = now() WHERE ${where}`,
    keyParams,
  }, hash, 'PAYLOAD_MISMATCH', handler), options);
}
