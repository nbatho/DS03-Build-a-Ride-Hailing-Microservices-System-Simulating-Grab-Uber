export const MATCHING_JOB_STATUSES = ['SEARCHING', 'OFFERING', 'CLAIMED', 'MATCHED', 'FAILED', 'CANCELLED'] as const;
export type MatchingJobStatus = typeof MATCHING_JOB_STATUSES[number];

export const OFFER_STATUSES = ['OPEN', 'CLAIMED', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED'] as const;
export type OfferStatus = typeof OFFER_STATUSES[number];

export const OFFER_DECISION_ACTIONS = ['ACCEPT', 'REJECT'] as const;
export type OfferDecisionAction = typeof OFFER_DECISION_ACTIONS[number];

export const OFFER_RESOLUTION_RESULTS = ['ASSIGNED', 'RETRY', 'CANCELLED'] as const;
export type OfferResolutionResult = typeof OFFER_RESOLUTION_RESULTS[number];

// Việc tìm tài xế: GET /internal/v1/matching/jobs/{tripId}, POST .../{tripId}/cancel (chỉ Trip gọi).

export interface MatchingJob {
  id: string;
  tripId: string;
  status: MatchingJobStatus;
  currentOfferId?: string;
  version: number;
}

/** POST /internal/v1/matching/jobs/{tripId}/cancel; tripVersion không được lùi. */
export interface CancelJobRequest {
  commandId: string;
  tripVersion: number;
}

// Lời mời: GET /internal/v1/offers/{offerId}, POST .../decisions, POST .../resolution (chỉ Trip gọi).

export interface Offer {
  id: string;
  jobId: string;
  tripId: string;
  driverId: string;
  status: OfferStatus;
  /** Lời mời mở 15 giây. */
  expiresAt: string;
  assignmentId?: string;
  version: number;
}

/** POST /internal/v1/offers/{offerId}/decisions; assignmentId là mã quyết định, không đổi khi retry. */
export interface OfferDecisionRequest {
  assignmentId: string;
  tripId: string;
  driverId: string;
  action: OfferDecisionAction;
}

/** POST /internal/v1/offers/{offerId}/resolution. */
export interface OfferResolutionRequest {
  commandId: string;
  assignmentId: string;
  tripId: string;
  result: OfferResolutionResult;
}
