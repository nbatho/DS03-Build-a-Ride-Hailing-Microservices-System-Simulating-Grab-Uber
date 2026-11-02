import {
  MAX_PAYMENT_ATTEMPTS,
  type PaymentFailedReason,
  type PaymentRequestedPayload,
  type PaymentStatus,
} from '@app/contracts';
import type { AttemptOutcome } from './payment.types';

// Quy tắc xử lý "yêu cầu thanh toán" (BA mục 5.6, 8.3; Phụ lục C EVT-09..11), tách khỏi DB để test được.

/** Phần của khoản thanh toán đã lưu mà quy tắc cần; entity Payment khớp sẵn kiểu này. */
export interface PaymentState {
  id: string;
  tripId: string;
  passengerId: string;
  amount: string;
  status: PaymentStatus;
  attemptNo: number;
  retryable: boolean;
}

export type AttemptDecision =
  /** Không làm gì: lần thử này đã chạy, hoặc thanh toán đã ở trạng thái cuối. */
  | { kind: 'SKIP'; reason: 'ALREADY_SUCCEEDED' | 'ATTEMPT_ALREADY_PROCESSED' | 'FINAL_FAILURE' }
  /** Dữ liệu không khớp bản đã lưu: không thử lại được, vào DLQ. */
  | { kind: 'REJECT'; code: 'PAYMENT_MISMATCH' | 'ATTEMPT_OUT_OF_RANGE'; message: string }
  | { kind: 'CHARGE' };

export function decideAttempt(state: PaymentState, request: PaymentRequestedPayload): AttemptDecision {
  // Cùng paymentId phải là cùng chuyến, cùng khách, cùng số tiền; không thu số tiền khác.
  if (
    state.tripId !== request.tripId ||
    state.passengerId !== request.passengerId ||
    state.amount !== request.amount
  ) {
    return {
      kind: 'REJECT',
      code: 'PAYMENT_MISMATCH',
      message: 'payment ' + state.id + ' does not match trip, passenger or amount of the request',
    };
  }

  if (request.attemptNo > MAX_PAYMENT_ATTEMPTS) {
    return {
      kind: 'REJECT',
      code: 'ATTEMPT_OUT_OF_RANGE',
      message: 'attemptNo ' + request.attemptNo + ' exceeds ' + MAX_PAYMENT_ATTEMPTS,
    };
  }

  // Thành công là trạng thái cuối; yêu cầu cũ hay mới đều không thu lần hai.
  if (state.status === 'SUCCEEDED') {
    return { kind: 'SKIP', reason: 'ALREADY_SUCCEEDED' };
  }

  // Bản gửi lại của lần thử đã chạy (event_id khác nhưng cùng attemptNo) không tạo lần thử mới.
  if (request.attemptNo <= state.attemptNo) {
    return { kind: 'SKIP', reason: 'ATTEMPT_ALREADY_PROCESSED' };
  }

  if (state.status === 'FAILED' && !state.retryable) {
    return { kind: 'SKIP', reason: 'FINAL_FAILURE' };
  }

  return { kind: 'CHARGE' };
}

/** Thành công không có lý do; thất bại luôn có lý do và cờ thử lại. */
export type AttemptResult =
  | { status: 'SUCCEEDED'; retryable: false; reason: null }
  | { status: 'FAILED'; retryable: boolean; reason: PaymentFailedReason };

/** Lỗi tạm thời ở lần thử cuối cùng thì không còn thử lại được. */
export function attemptResult(outcome: AttemptOutcome, attemptNo: number): AttemptResult {
  if (outcome === 'SUCCESS') {
    return { status: 'SUCCEEDED', retryable: false, reason: null };
  }

  if (outcome === 'FINAL_FAILURE') {
    return { status: 'FAILED', retryable: false, reason: 'SIMULATED_FINAL_FAILURE' };
  }

  return {
    status: 'FAILED',
    retryable: attemptNo < MAX_PAYMENT_ATTEMPTS,
    reason: 'SIMULATED_TEMPORARY_FAILURE',
  };
}
