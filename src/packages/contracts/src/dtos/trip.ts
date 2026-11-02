import type { TripCancelReason } from '../events/trip';
import type { Currency, MoneyAmount, Point } from './common';
import type { TripStatus } from './notification';

export const TRIP_PAYMENT_STATUSES = ['NOT_REQUESTED', 'PENDING', 'PENDING_RETRY', 'SUCCEEDED', 'FAILED'] as const;
export type TripPaymentStatus = typeof TRIP_PAYMENT_STATUSES[number];

export const OPERATION_TYPES = ['ACCEPT', 'REJECT', 'CANCEL', 'COMPLETE'] as const;
export type OperationType = typeof OPERATION_TYPES[number];

export const OPERATION_STATUSES = ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED_COMPENSATED', 'FAILED_NEEDS_REVIEW'] as const;
export type OperationStatus = typeof OPERATION_STATUSES[number];

export const REJECT_REASONS = ['UNAVAILABLE', 'NOT_INTERESTED'] as const;
export type RejectReason = typeof REJECT_REASONS[number];

export interface Trip {
  id: string;
  passengerId: string;
  driverId?: string;
  quoteId: string;
  assignmentId?: string;
  pickup: Point;
  dropoff: Point;
  amount: MoneyAmount;
  currency: Currency;
  status: TripStatus;
  paymentStatus: TripPaymentStatus;
  paymentId?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface TripsPage {
  items: Trip[];
  nextCursor?: string;
}

export interface Operation {
  id: string;
  tripId: string;
  type: OperationType;
  status: OperationStatus;
  tripStatus: TripStatus;
  assignmentId?: string;
  errorCode?: string;
  updatedAt: string;
}

export interface CreateTripRequest {
  quoteId: string;
}

export interface AcceptRequest {
  offerId: string;
}

export interface RejectRequest {
  offerId: string;
  reason: RejectReason;
}

export interface CancelRequest {
  reason: TripCancelReason;
}

export interface RetryOperationRequest {
  commandId: string;
  reason: string;
}
