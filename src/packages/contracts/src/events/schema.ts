import { CURRENCIES, ZONE_IDS } from '../dtos/common';
import { OFFER_STATUSES } from '../dtos/matching';
import { EVENT_CATALOG, EVENT_TYPES, isEventType, type EventPayloads, type EventType, type RideEvent } from './catalog';
import { EVENT_PRODUCERS, EVENT_SCHEMA_VERSION, RIDE_EVENTS_EXCHANGE } from './envelope';
import { MATCHING_FAILED_REASONS } from './matching';
import { PAYMENT_FAILED_REASONS } from './payment';
import { TRIP_CANCEL_REASONS, TRIP_NO_DRIVER_REASONS } from './trip';

// Kiểm tra JSON lúc chạy: type TypeScript không bảo vệ được tin đến từ RabbitMQ (BA mục 11.2).
// Cùng một mô tả field dùng cho validator và cho docs/api/events.schema.json để hai bản không lệch nhau.

type FieldSpec =
  | { kind: 'uuid' }
  | { kind: 'uuid[]' }
  | { kind: 'integer'; minimum: number }
  | { kind: 'money' }
  | { kind: 'boolean' }
  | { kind: 'datetime' }
  | { kind: 'string' }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'number'; minimum: number; maximum: number }
  | { kind: 'object'; fields: Fields };
type Field = FieldSpec & { optional?: boolean };
type Fields = Record<string, Field>;

const uuid: Field = { kind: 'uuid' };
const version: Field = { kind: 'integer', minimum: 1 };
const money: Field = { kind: 'money' };
const currency: Field = { kind: 'enum', values: CURRENCIES };
const point: Field = {
  kind: 'object',
  fields: {
    lat: { kind: 'number', minimum: -90, maximum: 90 },
    lng: { kind: 'number', minimum: -180, maximum: 180 },
    zoneId: { kind: 'enum', values: ZONE_IDS },
  },
};
const offer: Field = {
  kind: 'object',
  fields: {
    id: uuid,
    jobId: uuid,
    tripId: uuid,
    driverId: uuid,
    status: { kind: 'enum', values: OFFER_STATUSES },
    expiresAt: { kind: 'datetime' },
    assignmentId: { ...uuid, optional: true },
    version,
  },
};
const tripStatus = (status: string): Fields => ({
  tripId: uuid,
  passengerId: uuid,
  driverId: uuid,
  tripVersion: version,
  status: { kind: 'enum', values: [status] },
});

const PAYLOAD_FIELDS: { readonly [K in EventType]: Fields } = {
  'trip.requested': {
    tripId: uuid, passengerId: uuid, pickup: point, dropoff: point, amount: money, currency, tripVersion: version,
  },
  'matching.offer.created': { offer, pickup: point, dropoff: point, amount: money, currency },
  'matching.failed': {
    tripId: uuid, jobId: uuid, jobVersion: version, reason: { kind: 'enum', values: MATCHING_FAILED_REASONS },
  },
  'trip.no_driver': {
    tripId: uuid, passengerId: uuid, tripVersion: version, reason: { kind: 'enum', values: TRIP_NO_DRIVER_REASONS },
  },
  'trip.accepted': tripStatus('ASSIGNED'),
  'trip.started': tripStatus('IN_PROGRESS'),
  'trip.completed': tripStatus('COMPLETED'),
  'trip.cancelled': {
    tripId: uuid,
    passengerId: uuid,
    affectedDriverIds: { kind: 'uuid[]' },
    tripVersion: version,
    reason: { kind: 'enum', values: TRIP_CANCEL_REASONS },
  },
  'payment.requested': {
    paymentId: uuid, tripId: uuid, passengerId: uuid, amount: money, currency, attemptNo: version,
  },
  'payment.succeeded': {
    paymentId: uuid, tripId: uuid, passengerId: uuid, amount: money, currency, attemptNo: version,
    paymentVersion: version,
  },
  'payment.failed': {
    paymentId: uuid,
    tripId: uuid,
    passengerId: uuid,
    attemptNo: version,
    paymentVersion: version,
    retryable: { kind: 'boolean' },
    reason: { kind: 'enum', values: PAYMENT_FAILED_REASONS },
  },
};

const ENVELOPE_FIELDS: Fields = {
  event_id: uuid,
  type: { kind: 'enum', values: EVENT_TYPES },
  schema_version: { kind: 'integer', minimum: 1 },
  aggregate_id: uuid,
  aggregate_version: version,
  occurred_at: { kind: 'datetime' },
  correlation_id: uuid,
  causation_id: uuid,
  producer: { kind: 'enum', values: EVENT_PRODUCERS },
  payload: { kind: 'object', fields: {} },
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONEY_PATTERN = /^[0-9]{1,14}$/;
const DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkField(spec: FieldSpec, value: unknown, path: string, errors: string[]): void {
  switch (spec.kind) {
    case 'uuid':
      if (typeof value !== 'string' || !UUID_PATTERN.test(value)) errors.push(path + ' must be a UUID');
      return;
    case 'uuid[]':
      if (!Array.isArray(value)) errors.push(path + ' must be an array');
      else value.forEach((item, index) => checkField({ kind: 'uuid' }, item, path + '[' + index + ']', errors));
      return;
    case 'integer':
      if (!Number.isInteger(value) || (value as number) < spec.minimum) {
        errors.push(path + ' must be an integer >= ' + spec.minimum);
      }
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value) || value < spec.minimum || value > spec.maximum) {
        errors.push(path + ' must be a number in [' + spec.minimum + ', ' + spec.maximum + ']');
      }
      return;
    case 'money':
      if (typeof value !== 'string' || !MONEY_PATTERN.test(value)) errors.push(path + ' must be a VND integer string');
      return;
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(path + ' must be a boolean');
      return;
    case 'string':
      if (typeof value !== 'string' || value.length === 0) errors.push(path + ' must be a non-empty string');
      return;
    case 'datetime':
      if (typeof value !== 'string' || !DATETIME_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
        errors.push(path + ' must be an ISO-8601 date-time');
      }
      return;
    case 'enum':
      if (typeof value !== 'string' || !spec.values.includes(value)) {
        errors.push(path + ' must be one of ' + spec.values.join(', '));
      }
      return;
    case 'object':
      checkObject(spec.fields, value, path, errors);
      return;
  }
}

function checkObject(fields: Fields, value: unknown, path: string, errors: string[]): void {
  if (!isPlainObject(value)) {
    errors.push(path + ' must be an object');
    return;
  }
  for (const [name, field] of Object.entries(fields)) {
    const fieldPath = path + '.' + name;
    if (value[name] === undefined) {
      if (!field.optional) errors.push(fieldPath + ' is required');
      continue;
    }
    checkField(field, value[name], fieldPath, errors);
  }
  // Shape cố định theo schema_version; thêm field là thay đổi contract, không âm thầm nhận.
  for (const name of Object.keys(value)) {
    if (!(name in fields)) errors.push(path + '.' + name + ' is not allowed');
  }
}

/** aggregate_id/aggregate_version phải khớp mã/phiên bản đối tượng trong payload. */
function checkAggregate(event: RideEvent, errors: string[]): void {
  const payload = event.payload as unknown as Record<string, unknown>;
  const { aggregate } = EVENT_CATALOG[event.type];
  let expectedId: unknown;
  let expectedVersion: unknown;
  if (aggregate === 'trip') {
    expectedId = payload.tripId;
    expectedVersion = payload.tripVersion;
  } else if (aggregate === 'payment') {
    expectedId = payload.paymentId;
    expectedVersion = payload.paymentVersion;
  } else if (event.type === 'matching.offer.created') {
    expectedId = event.payload.offer.jobId;
  } else {
    expectedId = payload.jobId;
    expectedVersion = payload.jobVersion;
  }
  if (expectedId !== undefined && expectedId !== event.aggregate_id) {
    errors.push('$.aggregate_id must equal the ' + aggregate + ' id in payload');
  }
  if (expectedVersion !== undefined && expectedVersion !== event.aggregate_version) {
    errors.push('$.aggregate_version must equal the ' + aggregate + ' version in payload');
  }
}

export type EventValidationResult =
  | { ok: true; event: RideEvent }
  | { ok: false; errors: string[] };

export function validateRideEvent(input: unknown): EventValidationResult {
  const errors: string[] = [];
  if (!isPlainObject(input)) return { ok: false, errors: ['$ must be an object'] };
  const { payload, ...envelope } = input;
  checkObject(ENVELOPE_FIELDS, { ...envelope, payload: {} }, '$', errors);
  if (envelope.schema_version !== undefined && envelope.schema_version !== EVENT_SCHEMA_VERSION) {
    errors.push('$.schema_version must be ' + EVENT_SCHEMA_VERSION);
  }
  if (!isEventType(envelope.type)) return { ok: false, errors };
  if (envelope.producer !== undefined && envelope.producer !== EVENT_CATALOG[envelope.type].producer) {
    errors.push('$.producer must be ' + EVENT_CATALOG[envelope.type].producer + ' for ' + envelope.type);
  }
  checkObject(PAYLOAD_FIELDS[envelope.type], payload, '$.payload', errors);
  if (errors.length > 0) return { ok: false, errors };
  const event = input as unknown as RideEvent;
  checkAggregate(event, errors);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, event };
}

export class EventValidationError extends Error {
  constructor(readonly errors: string[]) {
    super('Invalid ride event: ' + errors.join('; '));
    this.name = 'EventValidationError';
  }
}

export function assertRideEvent(input: unknown): RideEvent;
export function assertRideEvent<T extends EventType>(input: unknown, type: T): RideEvent<T>;
export function assertRideEvent(input: unknown, type?: EventType): RideEvent {
  const result = validateRideEvent(input);
  if (!result.ok) throw new EventValidationError(result.errors);
  if (type !== undefined && result.event.type !== type) {
    throw new EventValidationError(['$.type must be ' + type]);
  }
  return result.event;
}

/** Field của payload dùng cho kiểu tham số generic, ví dụ khi dựng envelope ở bên gửi. */
export type PayloadOf<T extends EventType> = EventPayloads[T];

function toJsonSchema(spec: FieldSpec): Record<string, unknown> {
  switch (spec.kind) {
    case 'uuid':
      return { type: 'string', format: 'uuid' };
    case 'uuid[]':
      return { type: 'array', items: { type: 'string', format: 'uuid' } };
    case 'integer':
      return { type: 'integer', minimum: spec.minimum };
    case 'number':
      return { type: 'number', minimum: spec.minimum, maximum: spec.maximum };
    case 'money':
      return { type: 'string', pattern: MONEY_PATTERN.source };
    case 'boolean':
      return { type: 'boolean' };
    case 'string':
      return { type: 'string', minLength: 1 };
    case 'datetime':
      return { type: 'string', format: 'date-time' };
    case 'enum':
      return spec.values.length === 1 ? { const: spec.values[0] } : { enum: [...spec.values] };
    case 'object':
      return objectSchema(spec.fields);
  }
}

function objectSchema(fields: Fields): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: Object.entries(fields).filter(([, field]) => !field.optional).map(([name]) => name),
    properties: Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, toJsonSchema(field)])),
  };
}

/** Bản máy đọc được của Phụ lục C (docs/api/events.schema.json). */
export function buildEventsJsonSchema(): Record<string, unknown> {
  const envelope = objectSchema(ENVELOPE_FIELDS);
  const envelopeProperties = envelope.properties as Record<string, unknown>;
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://ds03.local/events.schema.json',
    title: 'DS03 ride events',
    description: 'Exchange topic ' + RIDE_EVENTS_EXCHANGE + '; routing key = type; schema_version = '
      + EVENT_SCHEMA_VERSION + '. Sinh từ src/packages/contracts/src/events/schema.ts, không sửa tay.',
    oneOf: EVENT_TYPES.map(type => ({ $ref: '#/$defs/' + type })),
    $defs: Object.fromEntries(EVENT_TYPES.map(type => {
      const definition = EVENT_CATALOG[type];
      return [type, {
        ...envelope,
        title: definition.code + ' ' + type,
        description: definition.note,
        'x-producer': definition.producer,
        'x-queues': definition.queues,
        properties: {
          ...envelopeProperties,
          type: { const: type },
          schema_version: { const: EVENT_SCHEMA_VERSION },
          producer: { const: definition.producer },
          payload: objectSchema(PAYLOAD_FIELDS[type]),
        },
      }];
    })),
  };
}
