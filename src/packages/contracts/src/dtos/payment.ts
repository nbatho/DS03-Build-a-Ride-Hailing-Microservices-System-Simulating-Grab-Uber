import type { Currency, MoneyAmount } from './common';

// Thanh toán mô phỏng (Phụ lục A API-33..35, Phụ lục B "Payment").

export const PAYMENT_STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED'] as const;
export type PaymentStatus = typeof PAYMENT_STATUSES[number];

/**
 * Trả về từ GET /api/v1/payments/{paymentId}, GET /api/v1/payments?tripId=
 * và GET /internal/v1/payments/{paymentId} (chỉ Trip gọi).
 */
export interface Payment {
  id: string;
  tripId: string;
  passengerId: string;
  amount: MoneyAmount;
  currency: Currency;
  status: PaymentStatus;
  /** 0 khi chưa thử lần nào, tối đa 3. */
  attemptNo: number;
  retryable: boolean;
  updatedAt: string;
}
