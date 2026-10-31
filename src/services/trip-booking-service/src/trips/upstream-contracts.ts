import { isUUID } from 'class-validator';
import {
  MATCHING_JOB_STATUSES,
  OFFER_STATUSES,
  RESERVATION_STATUSES,
  ZONE_IDS,
  type MatchingJob,
  type MatchingJobStatus,
  type Offer,
  type OfferStatus,
  type Point,
  type Quote,
  type Reservation,
  type ReservationStatus,
  type ZoneId,
} from '@app/contracts';
import { ApiError, type InternalResponse } from '@app/runtime';

const AMOUNT = /^\d{1,14}$/;

export type UpstreamResult<T> = { ok: true; body: T } | { ok: false; code: string };

// 400, 401, 403 nội bộ là lỗi cấu hình hoặc lỗi code, không phải kết quả nghiệp vụ nên không được kích hoạt bù trừ.
export function readResult<T>(
  service: string,
  response: InternalResponse<unknown>,
  read: (body: unknown) => T,
): UpstreamResult<T> {
  if (response.status === 200) {
    return { ok: true, body: read(response.body) };
  }

  const code = (response.body as { code?: unknown } | undefined)?.code;

  if (
    typeof code === 'string' &&
    (response.status === 409 ||
      response.status === 404 ||
      (response.status === 403 && code === 'DRIVER_MISMATCH'))
  ) {
    return { ok: false, code };
  }

  throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE', service + ' is unavailable');
}

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

export function readOffer(value: unknown, offerId: string): Offer {
  const offer = value as Partial<Offer> | null;

  if (
    !offer ||
    offer.id !== offerId ||
    !isUUID(offer.jobId) ||
    !isUUID(offer.tripId) ||
    !isUUID(offer.driverId) ||
    !OFFER_STATUSES.includes(offer.status as OfferStatus) ||
    typeof offer.expiresAt !== 'string' ||
    Number.isNaN(Date.parse(offer.expiresAt)) ||
    !isPositiveInt(offer.version)
  ) {
    throw invalid('Matching');
  }

  return offer as Offer;
}

export function readReservation(
  value: unknown,
  reservationId: string,
  tripId: string,
  driverId: string,
): Reservation {
  const reservation = value as Partial<Reservation> | null;

  if (
    !reservation ||
    reservation.id !== reservationId ||
    reservation.tripId !== tripId ||
    reservation.driverId !== driverId ||
    !RESERVATION_STATUSES.includes(reservation.status as ReservationStatus) ||
    !isPositiveInt(reservation.version)
  ) {
    throw invalid('Driver');
  }

  return reservation as Reservation;
}
