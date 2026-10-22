import type { Currency, MoneyAmount, Point } from '../dtos/common';

// Sự kiện do trip-booking-service phát (Phụ lục C, EVT-01, 04–09). aggregate_id của envelope = tripId.

export const TRIP_EVENT_PRODUCER = 'trip-booking-service';

export const TRIP_EVENT_TYPES = {
  REQUESTED: 'trip.requested',
  NO_DRIVER: 'trip.no_driver',
  ACCEPTED: 'trip.accepted',
  STARTED: 'trip.started',
  COMPLETED: 'trip.completed',
  CANCELLED: 'trip.cancelled',
  PAYMENT_REQUESTED: 'payment.requested',
} as const;
export type TripEventType = typeof TRIP_EVENT_TYPES[keyof typeof TRIP_EVENT_TYPES];

export const TRIP_NO_DRIVER_REASONS = ['NO_CANDIDATE', 'SEARCH_TIMEOUT'] as const;
export type TripNoDriverReason = typeof TRIP_NO_DRIVER_REASONS[number];

export const TRIP_CANCEL_REASONS = ['CHANGE_PLAN', 'WAIT_TOO_LONG'] as const;
export type TripCancelReason = typeof TRIP_CANCEL_REASONS[number];

/** EVT-01 "Có chuyến mới": Matching tạo job idempotent theo tripId; không mở lại tombstone đã hủy. */
export interface TripRequestedPayload {
  tripId: string;
  passengerId: string;
  pickup: Point;
  dropoff: Point;
  amount: MoneyAmount;
  currency: Currency;
  tripVersion: number;
}

/** EVT-04 "Không có tài xế": chỉ Trip phát sau khi commit NO_DRIVER. */
export interface TripNoDriverPayload {
  tripId: string;
  passengerId: string;
  tripVersion: number;
  reason: TripNoDriverReason;
}

interface TripStatusPayload<TStatus extends string> {
  tripId: string;
  passengerId: string;
  driverId: string;
  tripVersion: number;
  status: TStatus;
}

/** EVT-05 "Đã có tài xế nhận". */
export type TripAcceptedPayload = TripStatusPayload<'ASSIGNED'>;
/** EVT-06 "Chuyến bắt đầu". */
export type TripStartedPayload = TripStatusPayload<'IN_PROGRESS'>;
/** EVT-07 "Chuyến hoàn thành". */
export type TripCompletedPayload = TripStatusPayload<'COMPLETED'>;

/** EVT-08 "Chuyến bị hủy": affectedDriverIds là tài xế của assignment đã lưu tại Trip, có thể rỗng. Không broadcast. */
export interface TripCancelledPayload {
  tripId: string;
  passengerId: string;
  affectedDriverIds: string[];
  tripVersion: number;
  reason: TripCancelReason;
}

/** EVT-09 "Yêu cầu thanh toán": chỉ phát khi Trip COMPLETED; paymentId cố định theo chuyến. */
export interface PaymentRequestedPayload {
  paymentId: string;
  tripId: string;
  passengerId: string;
  amount: MoneyAmount;
  currency: Currency;
  attemptNo: number;
}
