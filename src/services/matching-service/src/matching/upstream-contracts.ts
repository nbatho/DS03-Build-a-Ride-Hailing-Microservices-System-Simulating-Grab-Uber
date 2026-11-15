import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { Candidates } from '@app/contracts';
import { ApiError } from '@app/runtime';

// Bản trích openapi.json của BA để kiểm tra response của Driver và Trip; webpack đóng gói cùng app.
// Sự kiện không kiểm tra ở đây: EventConsumer/createRideEvent của @app/messaging dùng contract chung.
const httpSchema = require('./http.schema.json');
const ajv = new Ajv2020({ strict: false });

addFormats(ajv);

const validCandidates = ajv.compile({ ...httpSchema, $ref: '#/components/schemas/Candidates' });
const validTrip = ajv.compile({ ...httpSchema, $ref: '#/components/schemas/Trip' });

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
