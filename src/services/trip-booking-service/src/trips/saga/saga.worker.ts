import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { runInTransaction } from '@app/runtime';
import { MAX_CYCLES, RENEW_INTERVAL_MS, backoffMs, onExhausted } from './saga-rules';
import { SagaSteps, type StepResult } from './saga-steps';
import { LeaseLostError, SagaStore, type ClaimedOperation, type StepOutcome } from './saga.store';

const POLL_INTERVAL_MS = 500;
const MAX_IN_FLIGHT = 5;

@Injectable()
export class SagaWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('SagaWorker');

  private readonly inFlight = new Set<Promise<void>>();

  private timer?: NodeJS.Timeout;

  private polling = false;

  private stopping = false;

  constructor(
    private readonly database: DataSource,
    private readonly store: SagaStore,
    private readonly steps: SagaSteps,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    await Promise.allSettled([...this.inFlight]);
  }

  private async poll(): Promise<void> {
    const capacity = MAX_IN_FLIGHT - this.inFlight.size;

    if (this.polling || this.stopping || capacity <= 0) {
      return;
    }

    this.polling = true;

    try {
      for (const operation of await this.store.claim(capacity)) {
        const task = this.drive(operation).finally(() => {
          this.inFlight.delete(task);
        });

        this.inFlight.add(task);
      }
    } catch (error) {
      this.logger.warn('Saga claim failed: ' + describe(error));
    } finally {
      this.polling = false;
    }
  }

  private async drive(operation: ClaimedOperation): Promise<void> {
    let lost = false;
    const renewal = setInterval(() => {
      this.store
        .renew(operation)
        .then(renewed => {
          lost = lost || !renewed;
        })
        .catch((error: unknown) => this.logger.warn('Saga lease renewal failed: ' + describe(error)));
    }, RENEW_INTERVAL_MS);

    renewal.unref();

    try {
      let current = operation;

      while (!lost) {
        if (this.stopping) {
          await this.commit(current, { kind: 'wait', delayMs: 0 });

          return;
        }

        const outcome = await this.runStep(current);

        if (outcome?.kind !== 'next') {
          return;
        }

        current = { ...current, currentStep: outcome.step, attemptCount: 0 };
      }
    } catch (error) {
      const message = 'Operation ' + operation.id + ' stopped: ' + describe(error);

      if (error instanceof LeaseLostError) {
        this.logger.warn(message);
      } else {
        this.logger.error(message);
      }
    } finally {
      clearInterval(renewal);
    }
  }

  private async runStep(operation: ClaimedOperation): Promise<StepOutcome | null> {
    try {
      return await this.commit(operation, await this.steps.run(operation));
    } catch (error) {
      if (error instanceof LeaseLostError) {
        throw error;
      }

      const recovered = this.steps.recover(operation, error);

      if (recovered) {
        return this.commit(operation, recovered);
      }

      return this.handleFailure(operation, error);
    }
  }

  private async handleFailure(
    operation: ClaimedOperation,
    error: unknown,
  ): Promise<StepOutcome | null> {
    this.logger.warn(
      'Operation ' + operation.id + ' ' + operation.currentStep + ' failed: ' + describe(error),
    );

    if (operation.attemptCount + 1 < MAX_CYCLES) {
      await this.store.retryLater(operation, backoffMs(operation.attemptCount));

      return null;
    }

    const target = onExhausted(operation.currentStep);

    return this.commit(
      operation,
      target === 'FAILED_NEEDS_REVIEW'
        ? { kind: 'finish', status: target, errorCode: 'DEPENDENCY_UNAVAILABLE' }
        : { kind: 'next', step: target, errorCode: 'DEPENDENCY_UNAVAILABLE' },
    );
  }

  private commit(operation: ClaimedOperation, result: StepResult): Promise<StepOutcome> {
    return runInTransaction(this.database, async manager => {
      await this.store.assertLease(manager, operation);

      const outcome = typeof result === 'function' ? await result(manager) : result;

      await this.store.apply(manager, operation, outcome);

      return outcome;
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
