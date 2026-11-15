import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { createRideEvent, enqueueOutboxEvent } from '@app/messaging';
import { DriverClient } from '../driver.client';
import { Trip } from '../entities/trip.entity';
import { MatchingClient } from '../matching.client';
import { paymentRequestedEvent } from '../trip-payment-rules';
import { transitionTrip } from '../trip-transition';
import { isUniqueViolation } from '../database-error';
import { TRIP_OUTBOX_TABLE } from '../trip-tables';
import { isClosedResolution, type SagaStepName } from './saga-rules';
import { SagaStore, type ClaimedOperation, type StepOutcome } from './saga.store';

export type StepResult = StepOutcome | ((manager: EntityManager) => Promise<StepOutcome>);

const next = (step: Extract<StepOutcome, { kind: 'next' }>['step'], errorCode?: string): StepOutcome => ({
  kind: 'next',
  step,
  ...(errorCode ? { errorCode } : {}),
});

const needsReview = (errorCode: string): StepOutcome => ({
  kind: 'finish',
  status: 'FAILED_NEEDS_REVIEW',
  errorCode,
});

const COMPENSATED: StepOutcome = { kind: 'finish', status: 'FAILED_COMPENSATED' };

@Injectable()
export class SagaSteps {
  constructor(
    private readonly database: DataSource,
    private readonly store: SagaStore,
    private readonly matching: MatchingClient,
    private readonly drivers: DriverClient,
  ) {}

  run(operation: ClaimedOperation): Promise<StepResult> {
    switch (operation.currentStep) {
      case 'REJECT_OFFER':
        return this.rejectOffer(operation);
      case 'CLAIM_OFFER':
        return this.claimOffer(operation);
      case 'RESERVE_DRIVER':
        return this.reserveDriver(operation);
      case 'CONFIRM_DRIVER':
        return this.confirmDriver(operation);
      case 'COMMIT_ASSIGNMENT':
        return this.commitAssignment(operation);
      case 'FINALIZE_MATCHING':
        return this.finalizeMatching(operation);
      case 'PUBLISH_AND_FINISH':
        return this.finishWhenPublished(operation, 'COMMIT_ASSIGNMENT');
      case 'RELEASE_DRIVER':
        return this.releaseDriver(operation);
      case 'RESOLVE_RETRY':
        return this.resolveRetry(operation);
      case 'RETURN_TO_MATCHING':
        return this.returnToMatching(operation);
      case 'CHECK_JOB':
        return this.checkJob(operation);
      case 'RELEASE_COMPLETED_DRIVER':
        return this.releaseCompletedDriver(operation);
      case 'REQUEST_PAYMENT':
        return this.requestPayment(operation);
      case 'PUBLISH_PAYMENT':
        return this.finishWhenPublished(operation, 'REQUEST_PAYMENT');
      case 'CANCEL_JOB':
        return this.cancelJob(operation);
      case 'RELEASE_CANCELLED_DRIVER':
        return this.releaseCancelledDriver(operation);
      case 'COMMIT_CANCELLED':
        return this.commitCancelled(operation);
      case 'PUBLISH_CANCELLED':
        return this.finishWhenPublished(operation, 'COMMIT_CANCELLED');
    }
  }

  // Tài xế đã có chuyến khác: bước gán chuyến không thể thành công nên trả xe, không thử lại.
  recover(operation: ClaimedOperation, error: unknown): StepOutcome | null {
    return operation.currentStep === 'COMMIT_ASSIGNMENT' &&
      isUniqueViolation(error, 'uq_trips_active_driver')
      ? next('RELEASE_DRIVER', 'DRIVER_UNAVAILABLE')
      : null;
  }

  private async rejectOffer(operation: ClaimedOperation): Promise<StepResult> {
    const result = await this.matching.decideOffer(
      operation.offerId!,
      {
        assignmentId: await this.store.commandId(operation, 'REJECT_OFFER'),
        tripId: operation.tripId,
        driverId: operation.driverId!,
        action: 'REJECT',
      },
      operation.correlationId,
    );

    return result.ok
      ? { kind: 'finish', status: 'SUCCEEDED' }
      : { kind: 'finish', status: 'FAILED_COMPENSATED', errorCode: result.code };
  }

  private async claimOffer(operation: ClaimedOperation): Promise<StepResult> {
    if (!(await this.isAssigning(operation))) {
      return next('RETURN_TO_MATCHING', 'TRIP_STATE_CHANGED');
    }

    const result = await this.matching.decideOffer(
      operation.offerId!,
      {
        assignmentId: operation.assignmentId!,
        tripId: operation.tripId,
        driverId: operation.driverId!,
        action: 'ACCEPT',
      },
      operation.correlationId,
    );

    return result.ok ? next('RESERVE_DRIVER') : next('RETURN_TO_MATCHING', result.code);
  }

  private async reserveDriver(operation: ClaimedOperation): Promise<StepResult> {
    if (!(await this.isAssigning(operation))) {
      return next('RELEASE_DRIVER', 'TRIP_STATE_CHANGED');
    }

    const known = await this.lookupReservation(operation);

    if (known) {
      return known;
    }

    const result = await this.drivers.reserve(
      operation.assignmentId!,
      { tripId: operation.tripId, driverId: operation.driverId!, offerId: operation.offerId! },
      operation.correlationId,
    );

    return result.ok ? next('CONFIRM_DRIVER') : next('RELEASE_DRIVER', result.code);
  }

  private async confirmDriver(operation: ClaimedOperation): Promise<StepResult> {
    if (!(await this.isAssigning(operation))) {
      return next('RELEASE_DRIVER', 'TRIP_STATE_CHANGED');
    }

    const known = await this.lookupReservation(operation);

    if (known) {
      return known;
    }

    const result = await this.drivers.confirm(
      operation.assignmentId!,
      {
        commandId: await this.store.commandId(operation, 'CONFIRM_DRIVER'),
        tripId: operation.tripId,
        driverId: operation.driverId!,
      },
      operation.correlationId,
    );

    if (!result.ok) {
      return next('RELEASE_DRIVER', result.code);
    }

    return result.body.status === 'CONFIRMED'
      ? next('COMMIT_ASSIGNMENT')
      : next('RELEASE_DRIVER', 'RESERVATION_NOT_CONFIRMED');
  }

  private async commitAssignment(operation: ClaimedOperation): Promise<StepResult> {
    const commandId = await this.store.commandId(operation, 'COMMIT_ASSIGNMENT');

    return async manager => {
      const updated = await transitionTrip(manager, {
        tripId: operation.tripId,
        to: 'ASSIGNED',
        assignmentId: operation.assignmentId!,
        set: { driverId: operation.driverId! },
        actorId: operation.actorId,
        commandId,
        correlationId: operation.correlationId,
      });

      if (!updated) {
        return next('RELEASE_DRIVER', 'TRIP_STATE_CHANGED');
      }

      await enqueueOutboxEvent(
        manager,
        TRIP_OUTBOX_TABLE,
        createRideEvent('trip.accepted', {
          eventId: commandId,
          aggregateId: operation.tripId,
          aggregateVersion: updated.version,
          correlationId: operation.correlationId,
          causationId: operation.id,
          payload: {
            tripId: operation.tripId,
            passengerId: updated.passengerId,
            driverId: operation.driverId!,
            tripVersion: updated.version,
            status: 'ASSIGNED',
          },
        }),
      );

      return next('FINALIZE_MATCHING');
    };
  }

  private async finalizeMatching(operation: ClaimedOperation): Promise<StepResult> {
    const result = await this.matching.resolveOffer(
      operation.offerId!,
      {
        commandId: await this.store.commandId(operation, 'FINALIZE_MATCHING'),
        assignmentId: operation.assignmentId!,
        tripId: operation.tripId,
        result: 'ASSIGNED',
      },
      operation.correlationId,
    );

    if (result.ok) {
      return next('PUBLISH_AND_FINISH');
    }

    const trip = await this.findTrip(operation);

    // Khách hủy đúng lúc này nên job đã CANCELLED; xe do Saga hủy trả, không cần vận hành can thiệp.
    return trip.status === 'CANCELLING' || trip.status === 'CANCELLED'
      ? { kind: 'finish', status: 'FAILED_COMPENSATED', errorCode: result.code }
      : needsReview(result.code);
  }

  private async finishWhenPublished(
    operation: ClaimedOperation,
    eventStep: SagaStepName,
  ): Promise<StepResult> {
    const [event] = (await this.database.query(
      'SELECT status FROM trip_schema.outbox_events WHERE event_id = $1',
      [await this.store.commandId(operation, eventStep)],
    )) as Array<{ status: string }>;

    if (event?.status === 'PUBLISHED') {
      return { kind: 'finish', status: 'SUCCEEDED' };
    }

    return event?.status === 'FAILED'
      ? needsReview('EVENT_PUBLISH_FAILED')
      : { kind: 'wait', delayMs: 1000 };
  }

  private async releaseDriver(operation: ClaimedOperation): Promise<StepResult> {
    const result = await this.drivers.release(
      operation.assignmentId!,
      {
        commandId: await this.store.commandId(operation, 'RELEASE_DRIVER'),
        tripId: operation.tripId,
        driverId: operation.driverId!,
        reason: 'ASSIGNMENT_FAILED',
      },
      operation.correlationId,
    );

    return result.ok ? next('RESOLVE_RETRY') : needsReview(result.code);
  }

  private async resolveRetry(operation: ClaimedOperation): Promise<StepResult> {
    const trip = await this.findTrip(operation);
    const cancelled = trip.status === 'CANCELLING' || trip.status === 'CANCELLED';
    const result = await this.matching.resolveOffer(
      operation.offerId!,
      {
        commandId: await this.store.commandId(operation, 'RESOLVE_RETRY'),
        assignmentId: operation.assignmentId!,
        tripId: operation.tripId,
        result: cancelled ? 'CANCELLED' : 'RETRY',
      },
      operation.correlationId,
    );

    return result.ok || isClosedResolution(result.code)
      ? next('RETURN_TO_MATCHING')
      : needsReview(result.code);
  }

  private async returnToMatching(operation: ClaimedOperation): Promise<StepResult> {
    const commandId = await this.store.commandId(operation, 'RETURN_TO_MATCHING');

    return async manager => {
      const updated = await transitionTrip(manager, {
        tripId: operation.tripId,
        to: 'MATCHING',
        assignmentId: operation.assignmentId!,
        set: { assignmentId: null },
        actorId: null,
        commandId,
        correlationId: operation.correlationId,
      });

      return updated ? next('CHECK_JOB') : COMPENSATED;
    };
  }

  // Phải chạy sau khi đã commit MATCHING: matching.failed đến lúc ASSIGNING đã bị bỏ qua, chỉ lần đọc này bắt được.
  private async checkJob(operation: ClaimedOperation): Promise<StepResult> {
    const job = await this.matching.getJob(operation.tripId, operation.correlationId);

    if (!job) {
      return needsReview('JOB_NOT_FOUND');
    }

    if (job.status !== 'FAILED') {
      return COMPENSATED;
    }

    const commandId = await this.store.commandId(operation, 'CHECK_JOB');

    return async manager => {
      const updated = await transitionTrip(manager, {
        tripId: operation.tripId,
        to: 'NO_DRIVER',
        actorId: null,
        commandId,
        correlationId: operation.correlationId,
      });

      if (updated) {
        await enqueueOutboxEvent(
          manager,
          TRIP_OUTBOX_TABLE,
          createRideEvent('trip.no_driver', {
            eventId: commandId,
            aggregateId: operation.tripId,
            aggregateVersion: updated.version,
            correlationId: operation.correlationId,
            causationId: operation.id,
            payload: {
              tripId: operation.tripId,
              passengerId: updated.passengerId,
              tripVersion: updated.version,
              reason: 'NO_CANDIDATE',
            },
          }),
        );
      }

      return COMPENSATED;
    };
  }

  private async releaseCompletedDriver(operation: ClaimedOperation): Promise<StepResult> {
    const result = await this.drivers.release(
      operation.assignmentId!,
      {
        commandId: await this.store.commandId(operation, 'RELEASE_COMPLETED_DRIVER'),
        tripId: operation.tripId,
        driverId: operation.driverId!,
        reason: 'TRIP_COMPLETED',
      },
      operation.correlationId,
    );

    return result.ok ? next('REQUEST_PAYMENT') : needsReview(result.code);
  }

  private async requestPayment(operation: ClaimedOperation): Promise<StepResult> {
    const commandId = await this.store.commandId(operation, 'REQUEST_PAYMENT');

    return async manager => {
      const trips = manager.getRepository(Trip);
      const trip = await trips.findOneOrFail({
        where: { id: operation.tripId },
        relations: { fare: true },
      });

      await trips.update({ id: trip.id }, { paymentAttemptNo: 1 });
      await enqueueOutboxEvent(
        manager,
        TRIP_OUTBOX_TABLE,
        paymentRequestedEvent(trip, trip.fare, 1, {
          eventId: commandId,
          correlationId: operation.correlationId,
          causationId: operation.id,
        }),
      );

      return next('PUBLISH_PAYMENT');
    };
  }

  private async cancelJob(operation: ClaimedOperation): Promise<StepResult> {
    const trip = await this.findTrip(operation);
    const result = await this.matching.cancelJob(
      operation.tripId,
      {
        commandId: await this.store.commandId(operation, 'CANCEL_JOB'),
        tripVersion: trip.version,
      },
      operation.correlationId,
    );

    return result.ok ? next('RELEASE_CANCELLED_DRIVER') : needsReview(result.code);
  }

  private async releaseCancelledDriver(operation: ClaimedOperation): Promise<StepResult> {
    if (!operation.assignmentId || !operation.driverId) {
      return next('COMMIT_CANCELLED');
    }

    const result = await this.drivers.release(
      operation.assignmentId,
      {
        commandId: await this.store.commandId(operation, 'RELEASE_CANCELLED_DRIVER'),
        tripId: operation.tripId,
        driverId: operation.driverId,
        reason: 'TRIP_CANCELLED',
      },
      operation.correlationId,
    );

    return result.ok ? next('COMMIT_CANCELLED') : needsReview(result.code);
  }

  private async commitCancelled(operation: ClaimedOperation): Promise<StepResult> {
    const commandId = await this.store.commandId(operation, 'COMMIT_CANCELLED');

    return async manager => {
      const updated = await transitionTrip(manager, {
        tripId: operation.tripId,
        to: 'CANCELLED',
        actorId: operation.actorId,
        commandId,
        correlationId: operation.correlationId,
      });

      if (!updated) {
        return needsReview('TRIP_STATE_CHANGED');
      }

      await enqueueOutboxEvent(
        manager,
        TRIP_OUTBOX_TABLE,
        createRideEvent('trip.cancelled', {
          eventId: commandId,
          aggregateId: operation.tripId,
          aggregateVersion: updated.version,
          correlationId: operation.correlationId,
          causationId: operation.id,
          payload: {
            tripId: operation.tripId,
            passengerId: updated.passengerId,
            affectedDriverIds: operation.driverId ? [operation.driverId] : [],
            tripVersion: updated.version,
            reason: operation.reason!,
          },
        }),
      );

      return next('PUBLISH_CANCELLED');
    };
  }

  // 404 không kết luận lệnh cũ sẽ không đến, nên vẫn gửi lại và dựa vào mã lệnh cùng tombstone.
  private async lookupReservation(operation: ClaimedOperation): Promise<StepOutcome | null> {
    if (!operation.uncertain) {
      return null;
    }

    const result = await this.drivers.getReservation(
      operation.assignmentId!,
      operation.tripId,
      operation.driverId!,
      operation.correlationId,
    );

    if (!result.ok) {
      return null;
    }

    switch (result.body.status) {
      case 'CONFIRMED':
        return next('COMMIT_ASSIGNMENT');
      case 'HELD':
        return operation.currentStep === 'RESERVE_DRIVER' ? next('CONFIRM_DRIVER') : null;
      default:
        return next('RELEASE_DRIVER', 'RESERVATION_' + result.body.status);
    }
  }

  private async isAssigning(operation: ClaimedOperation): Promise<boolean> {
    const trip = await this.findTrip(operation);

    return trip.status === 'ASSIGNING' && trip.assignmentId === operation.assignmentId;
  }

  private findTrip(operation: ClaimedOperation): Promise<Trip> {
    return this.database.getRepository(Trip).findOneByOrFail({ id: operation.tripId });
  }
}
