import type { Currency, MoneyAmount, Point } from '../dtos/common';
import type { Offer } from '../dtos/matching';

// Sự kiện do matching-service phát (events.schema.json). aggregate_id của envelope = jobId.

export const MATCHING_EVENT_PRODUCER = 'matching-service';

export const MATCHING_EVENT_TYPES = {
  OFFER_CREATED: 'matching.offer.created',
  FAILED: 'matching.failed',
} as const;
export type MatchingEventType = typeof MATCHING_EVENT_TYPES[keyof typeof MATCHING_EVENT_TYPES];

export const MATCHING_FAILED_REASONS = ['NO_CANDIDATE', 'SEARCH_TIMEOUT'] as const;
export type MatchingFailedReason = typeof MATCHING_FAILED_REASONS[number];

/** "Có lời mời mới": Notification báo cho tài xế. */
export interface MatchingOfferCreatedPayload {
  offer: Offer;
  pickup: Point;
  dropoff: Point;
  amount: MoneyAmount;
  currency: Currency;
}

/** "Không tìm được tài xế": gửi đúng một lần cho mỗi việc tìm; Trip chuyển chuyến sang không có tài xế. */
export interface MatchingFailedPayload {
  tripId: string;
  jobId: string;
  jobVersion: number;
  reason: MatchingFailedReason;
}
