import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import type { OperationStatus, OperationType, TripCancelReason } from '@app/contracts';
import { Operation } from '../entities/operation.entity';
import { SagaStep } from '../entities/saga-step.entity';
import {
  ACCEPT_STEPS,
  CANCEL_STEPS,
  COMPLETE_STEPS,
  LEASE_SECONDS,
  REJECT_STEPS,
  type SagaStepName,
} from './saga-rules';

const STEPS_BY_TYPE = {
  ACCEPT: ACCEPT_STEPS,
  REJECT: REJECT_STEPS,
  COMPLETE: COMPLETE_STEPS,
  CANCEL: CANCEL_STEPS,
} as const;

export type StepOutcome =
  | { kind: 'next'; step: SagaStepName; errorCode?: string }
  | { kind: 'wait'; delayMs: number }
  | { kind: 'finish'; status: OperationStatus; errorCode?: string };

export interface ClaimedOperation {
  id: string;
  tripId: string;
  actorId: string;
  type: OperationType;
  assignmentId: string | null;
  offerId: string | null;
  driverId: string | null;
  reason: TripCancelReason | null;
  currentStep: SagaStepName;
  attemptCount: number;
  uncertain: boolean;
  leaseToken: string;
  correlationId: string;
}

export interface NewOperation {
  tripId: string;
  actorId: string;
  type: keyof typeof STEPS_BY_TYPE;
  assignmentId: string | null;
  offerId: string | null;
  driverId?: string | null;
  reason?: TripCancelReason;
  correlationId: string;
  now: Date;
}

interface OperationRow {
  id: string;
  trip_id: string;
  actor_id: string;
  type: OperationType;
  assignment_id: string | null;
  offer_id: string | null;
  driver_id: string | null;
  reason: TripCancelReason | null;
  current_step: SagaStepName;
  attempt_count: number;
  lease_token: string;
  correlation_id: string;
  resumed: boolean;
}

export class LeaseLostError extends Error {
  constructor(operationId: string) {
    super('Lost the lease on operation ' + operationId);
    this.name = 'LeaseLostError';
  }
}

@Injectable()
export class SagaStore {
  constructor(private readonly database: DataSource) {}

  async createOperation(manager: EntityManager, input: NewOperation): Promise<Operation> {
    const steps: readonly SagaStepName[] = STEPS_BY_TYPE[input.type];
    const operations = manager.getRepository(Operation);
    const operation = operations.create({
      id: randomUUID(),
      tripId: input.tripId,
      actorId: input.actorId,
      type: input.type,
      status: 'PENDING',
      assignmentId: input.assignmentId,
      offerId: input.offerId,
      driverId: input.driverId === undefined ? input.actorId : input.driverId,
      reason: input.reason ?? null,
      currentStep: steps[0],
      attemptCount: 0,
      nextRetryAt: input.now,
      leaseToken: null,
      leaseUntil: null,
      errorCode: null,
      correlationId: input.correlationId,
      createdAt: input.now,
      updatedAt: input.now,
    });

    await operations.insert(operation);
    await manager.getRepository(SagaStep).insert(
      steps.map(step => ({
        operationId: operation.id,
        step,
        commandId: step === 'CLAIM_OFFER' && input.assignmentId ? input.assignmentId : randomUUID(),
        status: 'PENDING' as const,
        updatedAt: input.now,
      })),
    );

    return operation;
  }

  async claim(limit: number): Promise<ClaimedOperation[]> {
    const rows = (await this.database.query(
      `WITH claimed AS (
         UPDATE trip_schema.operations AS o
            SET status = 'RUNNING', lease_token = $1,
                lease_until = now() + make_interval(secs => $2), updated_at = now()
           FROM (SELECT id, lease_token IS NOT NULL AS resumed FROM trip_schema.operations
                  WHERE status IN ('PENDING', 'RUNNING') AND next_retry_at <= now()
                    AND (lease_until IS NULL OR lease_until < now())
                  ORDER BY next_retry_at, id
                  LIMIT $3
                  FOR UPDATE SKIP LOCKED) AS c
          WHERE o.id = c.id
      RETURNING o.*, c.resumed)
       SELECT * FROM claimed`,
      [randomUUID(), LEASE_SECONDS, limit],
    )) as OperationRow[];

    return rows.map(row => ({
      id: row.id,
      tripId: row.trip_id,
      actorId: row.actor_id,
      type: row.type,
      assignmentId: row.assignment_id,
      offerId: row.offer_id,
      driverId: row.driver_id,
      reason: row.reason,
      currentStep: row.current_step,
      attemptCount: row.attempt_count,
      uncertain: row.attempt_count > 0 || row.resumed,
      leaseToken: row.lease_token,
      correlationId: row.correlation_id,
    }));
  }

  async commandId(operation: ClaimedOperation, step: SagaStepName): Promise<string> {
    const row = await this.database
      .getRepository(SagaStep)
      .findOneByOrFail({ operationId: operation.id, step });

    return row.commandId;
  }

  async renew(operation: ClaimedOperation): Promise<boolean> {
    const rows = (await this.database.query(
      `WITH renewed AS (
         UPDATE trip_schema.operations SET lease_until = now() + make_interval(secs => $3)
          WHERE id = $1 AND lease_token = $2
      RETURNING id)
       SELECT id FROM renewed`,
      [operation.id, operation.leaseToken, LEASE_SECONDS],
    )) as unknown[];

    return rows.length === 1;
  }

  async retryLater(operation: ClaimedOperation, delayMs: number): Promise<void> {
    const rows = (await this.database.query(
      `WITH retried AS (
         UPDATE trip_schema.operations
            SET attempt_count = attempt_count + 1, next_retry_at = now() + make_interval(secs => $3),
                lease_token = NULL, lease_until = NULL, updated_at = now()
          WHERE id = $1 AND lease_token = $2
      RETURNING id)
       SELECT id FROM retried`,
      [operation.id, operation.leaseToken, delayMs / 1000],
    )) as unknown[];

    if (rows.length !== 1) {
      throw new LeaseLostError(operation.id);
    }
  }

  async assertLease(manager: EntityManager, operation: ClaimedOperation): Promise<void> {
    const rows = (await manager.query(
      'SELECT id FROM trip_schema.operations WHERE id = $1 AND lease_token = $2 FOR UPDATE',
      [operation.id, operation.leaseToken],
    )) as unknown[];

    if (rows.length !== 1) {
      throw new LeaseLostError(operation.id);
    }
  }

  async apply(
    manager: EntityManager,
    operation: ClaimedOperation,
    outcome: StepOutcome,
  ): Promise<void> {
    const operations = manager.getRepository(Operation);
    const released = { leaseToken: null, leaseUntil: null, updatedAt: () => 'now()' };

    if (outcome.kind === 'wait') {
      await manager
        .createQueryBuilder()
        .update(Operation)
        .set({
          ...released,
          nextRetryAt: () => `now() + interval '${Math.ceil(outcome.delayMs)} milliseconds'`,
        })
        .where({ id: operation.id })
        .execute();

      return;
    }

    await manager.getRepository(SagaStep).update(
      { operationId: operation.id, step: operation.currentStep },
      { status: outcome.errorCode ? 'FAILED' : 'SUCCEEDED', updatedAt: new Date() },
    );

    const errorCode = outcome.errorCode ? { errorCode: outcome.errorCode } : {};

    if (outcome.kind === 'next') {
      await manager
        .createQueryBuilder()
        .update(Operation)
        .set({
          ...errorCode,
          currentStep: outcome.step,
          attemptCount: 0,
          nextRetryAt: () => 'now()',
          updatedAt: () => 'now()',
        })
        .where({ id: operation.id })
        .execute();

      return;
    }

    await operations
      .createQueryBuilder()
      .update(Operation)
      .set({ ...released, ...errorCode, status: outcome.status })
      .where({ id: operation.id })
      .execute();
  }
}
