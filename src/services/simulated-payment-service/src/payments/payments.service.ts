import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource, type EntityManager, type Repository } from 'typeorm';
import type { Payment as PaymentDto, PaymentRequestedPayload, RideEvent } from '@app/contracts';
import {
  NonRetryableEventError,
  createRideEvent,
  enqueueOutboxEvent,
  processEventOnce,
} from '@app/messaging';
import { ApiError, withDatabase } from '@app/runtime';
import { Payment, PaymentAttempt } from './entities';
import { attemptResult, decideAttempt, type AttemptResult } from './payment-rules';
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

type PaymentRequested = RideEvent<'payment.requested'>;

export function toPaymentDto(payment: Payment): PaymentDto {
  return {
    id: payment.id,
    tripId: payment.tripId,
    passengerId: payment.passengerId,
    amount: payment.amount,
    currency: 'VND',
    status: payment.status,
    attemptNo: payment.attemptNo,
    retryable: payment.retryable,
    updatedAt: payment.updatedAt.toISOString(),
  };
}

/** payment.succeeded / payment.failed cho lần thử vừa chạy; aggregate = khoản thanh toán, version mới. */
function resultEvent(payment: Payment, request: PaymentRequested, result: AttemptResult, version: number) {
  const envelope = {
    aggregateId: payment.id,
    aggregateVersion: version,
    correlationId: request.correlation_id,
    causationId: request.event_id,
  };
  const { attemptNo, amount } = request.payload;
  const ids = { paymentId: payment.id, tripId: payment.tripId, passengerId: payment.passengerId };

  if (result.status === 'SUCCEEDED') {
    return createRideEvent('payment.succeeded', {
      ...envelope,
      payload: { ...ids, amount, currency: 'VND', attemptNo, paymentVersion: version },
    });
  }

  return createRideEvent('payment.failed', {
    ...envelope,
    payload: { ...ids, attemptNo, paymentVersion: version, retryable: result.retryable, reason: result.reason },
  });
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger('PaymentsService');

  constructor(
    private readonly dataSource: DataSource,
    @Inject(PAYMENT_SIMULATOR_CONFIG) private readonly simulator: SimulatorConfig,
  ) {}

  private get payments(): Repository<Payment> {
    return this.dataSource.getRepository(Payment);
  }

  /**
   * Xử lý payment.requested: trong một transaction ghi "đã xử lý", tạo/khóa khoản thanh toán,
   * chạy lần thử mô phỏng, ghi lần thử, cập nhật trạng thái và ghi payment.succeeded/failed vào outbox.
   */
  async handlePaymentRequested(event: PaymentRequested): Promise<RequestOutcome> {
    const result = await processEventOnce(
      this.dataSource,
      { table: PAYMENT_PROCESSED_EVENTS_TABLE, consumerName: PAYMENT_CONSUMER_NAME },
      event,
      manager => this.chargeInTransaction(manager, event),
    );
    const outcome = result.duplicate ? 'DUPLICATE_EVENT' : result.result;

    this.logger.log(
      'payment.requested ' +
        event.event_id +
        ' payment=' +
        event.payload.paymentId +
        ' attempt=' +
        event.payload.attemptNo +
        ' -> ' +
        outcome,
    );

    return outcome;
  }

  getForPassenger(passengerId: string, paymentId: string): Promise<PaymentDto> {
    return withDatabase('Payment', async () => ownedBy(passengerId, await this.payments.findOneBy({ id: paymentId })));
  }

  getByTripForPassenger(passengerId: string, tripId: string): Promise<PaymentDto> {
    return withDatabase('Payment', async () => ownedBy(passengerId, await this.payments.findOneBy({ tripId })));
  }

  /** Trip đối soát: Payment là nguồn sự thật về kết quả thu tiền. */
  getForTrip(paymentId: string): Promise<PaymentDto> {
    return withDatabase('Payment', async () => toPaymentDto(found(await this.payments.findOneBy({ id: paymentId }))));
  }

  private async chargeInTransaction(manager: EntityManager, event: PaymentRequested): Promise<RequestOutcome> {
    const payment = await lockOrCreatePayment(manager, event.payload);
    const decision = decideAttempt(payment, event.payload);

    if (decision.kind === 'REJECT') {
      throw new NonRetryableEventError(decision.code, decision.message);
    }

    if (decision.kind === 'SKIP') {
      return decision.reason;
    }

    const { attemptNo } = event.payload;
    const outcome = simulateCharge(this.simulator, attemptNo);
    const result = attemptResult(outcome, attemptNo);
    const version = payment.version + 1;

    await manager.getRepository(PaymentAttempt).insert({
      paymentId: payment.id,
      attemptNo,
      result: outcome,
      retryable: result.retryable,
      reason: result.reason,
      sourceEventId: event.event_id,
      correlationId: event.correlation_id,
    });

    // Điều kiện version giữ an toàn nếu có ghi song song ngoài khóa hàng.
    const updated = await manager
      .getRepository(Payment)
      .update(
        { id: payment.id, version: payment.version },
        { status: result.status, attemptNo, retryable: result.retryable, version },
      );

    if (updated.affected !== 1) {
      throw new Error('payment ' + payment.id + ' changed concurrently');
    }

    await enqueueOutboxEvent(manager, PAYMENT_OUTBOX_TABLE, resultEvent(payment, event, result, version));

    return result.status;
  }
}

/**
 * Lần đầu thấy paymentId thì tạo PENDING; trùng id hoặc trùng chuyến thì bỏ qua. Sau đó khóa dòng theo paymentId.
 * Không tìm thấy nghĩa là chuyến đã có khoản thanh toán với mã khác: mỗi chuyến chỉ một khoản.
 */
async function lockOrCreatePayment(manager: EntityManager, request: PaymentRequestedPayload): Promise<Payment> {
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
      status: 'PENDING',
      version: 1,
      attemptNo: 0,
      retryable: true,
    })
    .orIgnore()
    .execute();

  const payment = await manager.getRepository(Payment).findOne({
    where: { id: request.paymentId },
    lock: { mode: 'pessimistic_write' },
  });

  if (!payment) {
    throw new NonRetryableEventError(
      'PAYMENT_MISMATCH',
      'trip ' + request.tripId + ' already has a payment with a different paymentId',
    );
  }

  return payment;
}

function found(payment: Payment | null): Payment {
  if (!payment) {
    throw new ApiError(404, 'PAYMENT_NOT_FOUND', 'Payment not found');
  }

  return payment;
}

/** passengerId đến từ sự kiện của Trip (nguồn tin cậy), so với sub trong JWT. */
function ownedBy(passengerId: string, payment: Payment | null): PaymentDto {
  const owned = found(payment);

  if (owned.passengerId !== passengerId) {
    throw new ApiError(403, 'RESOURCE_FORBIDDEN', 'Payment belongs to another passenger');
  }

  return toPaymentDto(owned);
}
