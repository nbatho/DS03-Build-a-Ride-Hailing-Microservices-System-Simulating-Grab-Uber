import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import type { Payment as PaymentDto, RideEvent } from '@app/contracts';
import {
  NonRetryableEventError,
  createRideEvent,
  enqueueOutboxEvent,
  processEventOnce,
} from '@app/messaging';
import { ApiError } from '@app/runtime';
import { Payment, PaymentAttempt, PaymentAttemptResult, PaymentStatus } from './entities';
import { attemptResult, decideAttempt, type PaymentState } from './payment-rules';
import { simulateCharge, type SimulatorConfig } from './payment-simulator';

export const PAYMENT_CONSUMER_NAME = 'simulated-payment-service';
export const PAYMENT_PROCESSED_EVENTS_TABLE = 'payment_schema.processed_events';
export const PAYMENT_OUTBOX_TABLE = 'payment_schema.outbox_events';
export const PAYMENT_SIMULATOR_CONFIG = Symbol('PAYMENT_SIMULATOR_CONFIG');

export type RequestOutcome =
  | 'DUPLICATE_EVENT'
  | 'ALREADY_SUCCEEDED'
  | 'ATTEMPT_ALREADY_PROCESSED'
  | 'FINAL_FAILURE'
  | 'SUCCEEDED'
  | 'FAILED';

export function toPaymentDto(payment: Payment): PaymentDto {
  return {
    id: payment.id,
    tripId: payment.tripId,
    passengerId: payment.passengerId,
    amount: String(payment.amount),
    currency: 'VND',
    status: payment.status,
    attemptNo: payment.attemptNo,
    retryable: payment.retryable,
    updatedAt: payment.updatedAt.toISOString(),
  };
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger('PaymentsService');

  constructor(
    private readonly dataSource: DataSource,
    @Inject(PAYMENT_SIMULATOR_CONFIG) private readonly simulator: SimulatorConfig,
  ) {}

  /**
   * Xử lý payment.requested (BA mục 5.6): trong một transaction ghi "đã xử lý", tạo/khóa khoản thanh toán,
   * chạy lần thử mô phỏng, ghi lần thử, cập nhật trạng thái và ghi payment.succeeded/failed vào outbox.
   */
  async handlePaymentRequested(event: RideEvent<'payment.requested'>): Promise<RequestOutcome> {
    const result = await processEventOnce(
      this.dataSource,
      { table: PAYMENT_PROCESSED_EVENTS_TABLE, consumerName: PAYMENT_CONSUMER_NAME },
      event,
      manager => this.chargeInTransaction(manager, event),
    );
    const outcome = result.duplicate ? 'DUPLICATE_EVENT' : result.result;

    this.logger.log(
      'payment.requested ' + event.event_id + ' payment=' + event.payload.paymentId +
        ' attempt=' + event.payload.attemptNo + ' -> ' + outcome,
    );

    return outcome;
  }

  async getForPassenger(passengerId: string, paymentId: string): Promise<PaymentDto> {
    return this.ownedBy(passengerId, await this.dataSource.getRepository(Payment).findOneBy({ id: paymentId }));
  }

  async getByTripForPassenger(passengerId: string, tripId: string): Promise<PaymentDto> {
    return this.ownedBy(passengerId, await this.dataSource.getRepository(Payment).findOneBy({ tripId }));
  }

  /** Trip đối soát: Payment là nguồn sự thật về kết quả thu tiền. */
  async getForTrip(paymentId: string): Promise<PaymentDto> {
    const payment = await this.dataSource.getRepository(Payment).findOneBy({ id: paymentId });

    if (!payment) {
      throw notFound();
    }

    return toPaymentDto(payment);
  }

  private ownedBy(passengerId: string, payment: Payment | null): PaymentDto {
    if (!payment) {
      throw notFound();
    }

    // passengerId đến từ sự kiện của Trip (nguồn tin cậy), so với sub trong JWT.
    if (payment.passengerId !== passengerId) {
      throw new ApiError(403, 'RESOURCE_FORBIDDEN', 'Payment belongs to another passenger');
    }

    return toPaymentDto(payment);
  }

  private async chargeInTransaction(
    manager: EntityManager,
    event: RideEvent<'payment.requested'>,
  ): Promise<RequestOutcome> {
    const request = event.payload;
    const payments = manager.getRepository(Payment);

    // Lần đầu thấy paymentId thì tạo PENDING; trùng id hoặc trùng chuyến thì bỏ qua rồi đọc bản đã có.
    await manager
      .createQueryBuilder()
      .insert()
      .into(Payment)
      .values({
        id: request.paymentId,
        tripId: request.tripId,
        passengerId: request.passengerId,
        amount: request.amount,
        currency: 'VND',
        status: PaymentStatus.PENDING,
        version: 1,
        attemptNo: 0,
        retryable: true,
      })
      .orIgnore()
      .execute();

    const payment = await payments.findOne({
      where: { id: request.paymentId },
      lock: { mode: 'pessimistic_write' },
    });

    if (!payment) {
      // Chuyến đã có khoản thanh toán với mã khác: mỗi chuyến chỉ một khoản.
      throw new NonRetryableEventError(
        'PAYMENT_MISMATCH',
        'trip ' + request.tripId + ' already has a payment with a different paymentId',
      );
    }

    const state: PaymentState = {
      id: payment.id,
      tripId: payment.tripId,
      passengerId: payment.passengerId,
      amount: String(payment.amount),
      status: payment.status,
      version: payment.version,
      attemptNo: payment.attemptNo,
      retryable: payment.retryable,
    };
    const decision = decideAttempt(state, request);

    if (decision.kind === 'REJECT') {
      throw new NonRetryableEventError(decision.code, decision.message);
    }

    if (decision.kind === 'SKIP') {
      return decision.reason;
    }

    const outcome = simulateCharge(this.simulator, request.attemptNo);
    const result = attemptResult(outcome, request.attemptNo);
    const version = payment.version + 1;

    await manager.getRepository(PaymentAttempt).insert({
      paymentId: payment.id,
      attemptNo: request.attemptNo,
      result: outcome as PaymentAttemptResult,
      retryable: result.retryable,
      reason: result.reason,
      sourceEventId: event.event_id,
      correlationId: event.correlation_id,
    });

    // Điều kiện version giữ an toàn nếu có ghi song song ngoài khóa hàng.
    const updated = await payments.update(
      { id: payment.id, version: payment.version },
      {
        status: result.status as PaymentStatus,
        attemptNo: request.attemptNo,
        retryable: result.retryable,
        version,
      },
    );

    if (updated.affected !== 1) {
      throw new Error('payment ' + payment.id + ' changed concurrently');
    }

    const common = {
      aggregateId: payment.id,
      aggregateVersion: version,
      correlationId: event.correlation_id,
      causationId: event.event_id,
    };
    const resultEvent =
      result.status === 'SUCCEEDED'
        ? createRideEvent('payment.succeeded', {
            ...common,
            payload: {
              paymentId: payment.id,
              tripId: payment.tripId,
              passengerId: payment.passengerId,
              amount: request.amount,
              currency: 'VND',
              attemptNo: request.attemptNo,
              paymentVersion: version,
            },
          })
        : createRideEvent('payment.failed', {
            ...common,
            payload: {
              paymentId: payment.id,
              tripId: payment.tripId,
              passengerId: payment.passengerId,
              attemptNo: request.attemptNo,
              paymentVersion: version,
              retryable: result.retryable,
              reason: result.reason ?? 'SIMULATED_FINAL_FAILURE',
            },
          });

    await enqueueOutboxEvent(manager, PAYMENT_OUTBOX_TABLE, resultEvent);

    return result.status;
  }
}

function notFound(): ApiError {
  return new ApiError(404, 'PAYMENT_NOT_FOUND', 'Payment not found');
}
