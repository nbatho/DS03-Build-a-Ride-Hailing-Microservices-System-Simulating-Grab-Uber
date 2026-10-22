import type { Currency, MoneyAmount } from '../dtos/common';

// Sự kiện do simulated-payment-service phát (Phụ lục C, EVT-10, 11). aggregate_id của envelope = paymentId.

export const PAYMENT_EVENT_PRODUCER = 'simulated-payment-service';

export const PAYMENT_EVENT_TYPES = {
  SUCCEEDED: 'payment.succeeded',
  FAILED: 'payment.failed',
} as const;
export type PaymentEventType = typeof PAYMENT_EVENT_TYPES[keyof typeof PAYMENT_EVENT_TYPES];

export const PAYMENT_FAILED_REASONS = ['SIMULATED_TEMPORARY_FAILURE', 'SIMULATED_FINAL_FAILURE'] as const;
export type PaymentFailedReason = typeof PAYMENT_FAILED_REASONS[number];

/** Trip điều phối tối đa 3 attempt nghiệp vụ cho một paymentId. */
export const MAX_PAYMENT_ATTEMPTS = 3;

/** EVT-10: SUCCEEDED là trạng thái cuối; event FAILED cũ không được làm lùi. */
export interface PaymentSucceededPayload {
  paymentId: string;
  tripId: string;
  passengerId: string;
  amount: MoneyAmount;
  currency: Currency;
  attemptNo: number;
  paymentVersion: number;
}

/** EVT-11: Notification ghi kết quả attempt, không tự hủy Trip. */
export interface PaymentFailedPayload {
  paymentId: string;
  tripId: string;
  passengerId: string;
  attemptNo: number;
  paymentVersion: number;
  retryable: boolean;
  reason: PaymentFailedReason;
}
