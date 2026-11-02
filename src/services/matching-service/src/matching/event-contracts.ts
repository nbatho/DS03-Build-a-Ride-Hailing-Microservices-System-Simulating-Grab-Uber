import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { Candidates, Point } from '@app/contracts';
import { ApiError } from '@app/runtime';

// Bản trích từ events.schema.json/openapi.json của BA; webpack đóng gói cùng app.
const eventSchema = require('./events.schema.json');
const httpSchema = require('./http.schema.json');
const ajv = new Ajv2020({ strict: false });

addFormats(ajv);

const validEvent = ajv.compile(eventSchema);
const validCandidates = ajv.compile({ ...httpSchema, $ref: '#/components/schemas/Candidates' });
const validTrip = ajv.compile({ ...httpSchema, $ref: '#/components/schemas/Trip' });

export interface EventEnvelope {
  event_id: string;
  type: string;
  schema_version: number;
  aggregate_id: string;
  aggregate_version: number;
  occurred_at: string;
  correlation_id: string;
  causation_id: string;
  producer: string;
}

export interface TripRequestedEvent extends EventEnvelope {
  type: 'trip.requested';
  payload: {
    tripId: string;
    passengerId: string;
    pickup: Point;
    dropoff: Point;
    amount: string;
    currency: 'VND';
    tripVersion: number;
  };
}

export interface TripCancelledEvent extends EventEnvelope {
  type: 'trip.cancelled';
  payload: {
    tripId: string;
    passengerId: string;
    affectedDriverIds: string[];
    tripVersion: number;
    reason: string;
  };
}

export interface TripView {
  id: string;
  status:
    | 'MATCHING'
    | 'ASSIGNING'
    | 'ASSIGNED'
    | 'IN_PROGRESS'
    | 'COMPLETED'
    | 'CANCELLING'
    | 'CANCELLED'
    | 'NO_DRIVER';
  version: number;
  assignmentId?: string;
  driverId?: string;
}

export function checkEvent(value: unknown): void {
  if (!validEvent(value)) {
    throw new ApiError(400, 'INVALID_EVENT', 'Event does not match the BA contract');
  }
}

export function readTripEvent(value: unknown): TripRequestedEvent | TripCancelledEvent {
  checkEvent(value);
  const event = value as TripRequestedEvent | TripCancelledEvent;

  if (
    !['trip.requested', 'trip.cancelled'].includes(event.type) ||
    event.aggregate_id !== event.payload.tripId ||
    event.aggregate_version !== event.payload.tripVersion
  ) {
    throw new ApiError(
      400,
      'INVALID_EVENT',
      'Trip event identity or version does not match its payload',
    );
  }

  return event;
}

export function readCandidates(value: unknown): Candidates {
  if (!validCandidates(value)) {
    throw new ApiError(
      502,
      'INVALID_UPSTREAM_RESPONSE',
      'Driver response does not match the contract',
    );
  }

  return value as Candidates;
}

export function readTrip(value: unknown, tripId: string): TripView {
  if (!validTrip(value) || (value as TripView).id !== tripId) {
    throw new ApiError(
      502,
      'INVALID_UPSTREAM_RESPONSE',
      'Trip response does not match the contract',
    );
  }

  return value as TripView;
}
