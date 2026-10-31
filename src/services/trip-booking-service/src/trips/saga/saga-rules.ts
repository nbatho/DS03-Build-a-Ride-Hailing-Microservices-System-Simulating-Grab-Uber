export const ACCEPT_STEPS = [
  'CLAIM_OFFER',
  'RESERVE_DRIVER',
  'CONFIRM_DRIVER',
  'COMMIT_ASSIGNMENT',
  'FINALIZE_MATCHING',
  'PUBLISH_AND_FINISH',
  'RELEASE_DRIVER',
  'RESOLVE_RETRY',
  'RETURN_TO_MATCHING',
  'CHECK_JOB',
] as const;

export const REJECT_STEPS = ['REJECT_OFFER'] as const;

export type SagaStepName = (typeof ACCEPT_STEPS)[number] | (typeof REJECT_STEPS)[number];

export const MAX_CYCLES = 5;
export const LEASE_SECONDS = 15;
export const RENEW_INTERVAL_MS = 5_000;

const BEFORE_COMMIT: readonly SagaStepName[] = ['CLAIM_OFFER', 'RESERVE_DRIVER', 'CONFIRM_DRIVER'];

const CLOSED_RESOLUTION_CODES = new Set([
  'ASSIGNMENT_MISMATCH',
  'RESOLUTION_CONFLICT',
  'JOB_CANCELLED',
  'PAYLOAD_MISMATCH',
]);

export function backoffMs(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** attempt);
}

export function onExhausted(step: SagaStepName): 'RELEASE_DRIVER' | 'FAILED_NEEDS_REVIEW' {
  return BEFORE_COMMIT.includes(step) ? 'RELEASE_DRIVER' : 'FAILED_NEEDS_REVIEW';
}

// Claim đã được đóng hoặc chưa từng tồn tại: bù trừ đi tiếp được.
export function isClosedResolution(code: string): boolean {
  return CLOSED_RESOLUTION_CODES.has(code);
}
