import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { Operation as OperationDto } from '@app/contracts';
import type { InternalCaller } from '@app/shared-types';
import { ApiError, withCommandResult } from '@app/runtime';
import { RetryOperationDto } from './dto/retry-operation.dto';
import { OperationRetry } from './entities/operation-retry.entity';
import { Operation, toOperation } from './entities/operation.entity';
import { SagaStep } from './entities/saga-step.entity';
import { Trip } from './entities/trip.entity';

@Injectable()
export class OperationRetryService {
  private readonly logger = new Logger('OperationRetryService');

  constructor(private readonly database: DataSource) {}

  async retry(
    operationId: string,
    dto: RetryOperationDto,
    caller: InternalCaller,
    correlationId: string,
  ): Promise<OperationDto> {
    const commandId = dto.commandId.toLowerCase();

    try {
      const result = await withCommandResult(
        this.database,
        {
          schema: 'trip_schema',
          callerService: caller,
          commandType: 'RETRY',
          commandId,
          resourceId: operationId,
          correlationId,
        },
        { reason: dto.reason },
        async manager => {
          const operations = manager.getRepository(Operation);
          const operation = await operations.findOne({
            where: { id: operationId },
            lock: { mode: 'pessimistic_write' },
          });

          if (!operation) {
            throw new ApiError(404, 'OPERATION_NOT_FOUND', 'Operation not found');
          }

          if (operation.status !== 'FAILED_NEEDS_REVIEW') {
            throw new ApiError(409, 'OPERATION_NOT_RETRYABLE', 'Only an operation needing review can be retried');
          }

          await manager.getRepository(OperationRetry).insert({
            id: randomUUID(),
            operationId,
            commandId,
            caller,
            reason: dto.reason,
            fromStep: operation.currentStep,
            previousErrorCode: operation.errorCode,
            correlationId,
          });

          await manager
            .getRepository(SagaStep)
            .update({ operationId, step: operation.currentStep }, { status: 'PENDING', updatedAt: new Date() });

          await manager
            .createQueryBuilder()
            .update(Operation)
            .set({
              status: 'PENDING',
              attemptCount: 0,
              errorCode: null,
              nextRetryAt: () => 'now()',
              updatedAt: () => 'now()',
            })
            .where({ id: operationId })
            .execute();

          const updated = await operations.findOneByOrFail({ id: operationId });
          const trip = await manager.getRepository(Trip).findOneByOrFail({ id: operation.tripId });

          return { status: 202, body: toOperation({ ...updated, trip }) };
        },
      );

      return result.body;
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }

      this.logger.error(error instanceof Error ? error.message : String(error));

      throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE', 'Trip database unavailable');
    }
  }
}
