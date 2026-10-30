import { isUUID } from 'class-validator';
import {
  MATCHING_JOB_STATUSES,
  ZONE_IDS,
  type MatchingJob,
  type MatchingJobStatus,
  type Point,
  type Quote,
  type ZoneId,
} from '@app/contracts';
import { ApiError } from '@app/runtime';

const AMOUNT = /^\d{1,14}$/;

function invalid(service: string): ApiError {
  return new ApiError(503, 'DEPENDENCY_UNAVAILABLE', service + ' response does not match the contract');
}

function readPoint(value: unknown): Point | undefined {
  const point = value as Partial<Point> | null;

  if (
    typeof point?.lat !== 'number' ||
    point.lat < -90 ||
    point.lat > 90 ||
    typeof point.lng !== 'number' ||
    point.lng < -180 ||
    point.lng > 180 ||
    !ZONE_IDS.includes(point.zoneId as ZoneId)
  ) {
    return undefined;
  }

  return { lat: point.lat, lng: point.lng, zoneId: point.zoneId as ZoneId };
}

function isPositiveInt(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1;
}

export function readQuote(value: unknown, quoteId: string): Quote {
  const quote = value as Partial<Quote> | null;
  const pickup = readPoint(quote?.pickup);
  const dropoff = readPoint(quote?.dropoff);

  if (
    !quote ||
    quote.id !== quoteId ||
    !isUUID(quote.passengerId) ||
    !pickup ||
    !dropoff ||
    !isPositiveInt(quote.distanceMeters) ||
    !isPositiveInt(quote.durationSeconds) ||
    typeof quote.amount !== 'string' ||
    !AMOUNT.test(quote.amount) ||
    quote.currency !== 'VND' ||
    typeof quote.ruleVersion !== 'string' ||
    !quote.ruleVersion ||
    typeof quote.expiresAt !== 'string' ||
    Number.isNaN(Date.parse(quote.expiresAt))
  ) {
    throw invalid('Pricing');
  }

  return { ...(quote as Quote), pickup, dropoff };
}

export function readJob(value: unknown, tripId: string): MatchingJob {
  const job = value as Partial<MatchingJob> | null;

  if (
    !job ||
    !isUUID(job.id) ||
    job.tripId !== tripId ||
    !MATCHING_JOB_STATUSES.includes(job.status as MatchingJobStatus) ||
    !isPositiveInt(job.version)
  ) {
    throw invalid('Matching');
  }

  return job as MatchingJob;
}
