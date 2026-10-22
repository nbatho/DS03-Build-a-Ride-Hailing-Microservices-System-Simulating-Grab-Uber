import type { EventEnvelope, EventProducer } from './envelope';
import type { MatchingFailedPayload, MatchingOfferCreatedPayload } from './matching';
import type { PaymentFailedPayload, PaymentSucceededPayload } from './payment';
import type {
  PaymentRequestedPayload,
  TripAcceptedPayload,
  TripCancelledPayload,
  TripCompletedPayload,
  TripNoDriverPayload,
  TripRequestedPayload,
  TripStartedPayload,
} from './trip';

// Event catalog và routing RabbitMQ (Phụ lục C, BA mục 8.1, 15.2). Đây là nguồn duy nhất để dựng
// exchange/queue/binding; không khai báo routing key ở chỗ khác.

/** Mỗi subscriber một queue riêng để cùng một sự kiện đến đủ các bên. */
export const EVENT_QUEUES = {
  MATCHING: 'matching.events',
  TRIP: 'trip.events',
  PAYMENT: 'payment.events',
  NOTIFICATION: 'notification.events',
} as const;
export type EventQueue = typeof EVENT_QUEUES[keyof typeof EVENT_QUEUES];

export interface EventPayloads {
  'trip.requested': TripRequestedPayload;
  'matching.offer.created': MatchingOfferCreatedPayload;
  'matching.failed': MatchingFailedPayload;
  'trip.no_driver': TripNoDriverPayload;
  'trip.accepted': TripAcceptedPayload;
  'trip.started': TripStartedPayload;
  'trip.completed': TripCompletedPayload;
  'trip.cancelled': TripCancelledPayload;
  'payment.requested': PaymentRequestedPayload;
  'payment.succeeded': PaymentSucceededPayload;
  'payment.failed': PaymentFailedPayload;
}
export type EventType = keyof EventPayloads;

/** Envelope đã kiểm tra, payload đúng kiểu theo `type`. */
export type RideEvent<T extends EventType = EventType> = { [K in T]: EventEnvelope<K, EventPayloads[K]> }[T];

/** aggregate_id là mã của đối tượng nào; ba dãy phiên bản không so với nhau (BA mục 8.3). */
export type EventAggregate = 'trip' | 'matching_job' | 'payment';

export interface EventDefinition {
  code: string;
  producer: EventProducer;
  aggregate: EventAggregate;
  queues: readonly EventQueue[];
  note: string;
}

export const EVENT_CATALOG: { readonly [K in EventType]: EventDefinition } = {
  'trip.requested': {
    code: 'EVT-01', producer: 'trip-booking-service', aggregate: 'trip', queues: [EVENT_QUEUES.MATCHING],
    note: 'Tạo job idempotent theo tripId; không mở lại tombstone đã hủy.',
  },
  'matching.offer.created': {
    code: 'EVT-02', producer: 'matching-service', aggregate: 'matching_job', queues: [EVENT_QUEUES.NOTIFICATION],
    note: 'Recipient = offer.driverId; đủ offerId/tripId để client accept; chưa phải đã gán chuyến.',
  },
  'matching.failed': {
    code: 'EVT-03', producer: 'matching-service', aggregate: 'matching_job', queues: [EVENT_QUEUES.TRIP],
    note: 'Trip xác minh state/phiên job trước khi chuyển NO_DRIVER; Notification không nghe event này.',
  },
  'trip.no_driver': {
    code: 'EVT-04', producer: 'trip-booking-service', aggregate: 'trip', queues: [EVENT_QUEUES.NOTIFICATION],
    note: 'Chỉ Trip phát sau commit NO_DRIVER.',
  },
  'trip.accepted': {
    code: 'EVT-05', producer: 'trip-booking-service', aggregate: 'trip', queues: [EVENT_QUEUES.NOTIFICATION],
    note: 'Thông báo cho passenger và assigned driver; kiểm tra aggregate version.',
  },
  'trip.started': {
    code: 'EVT-06', producer: 'trip-booking-service', aggregate: 'trip', queues: [EVENT_QUEUES.NOTIFICATION],
    note: 'Thông báo cho passenger và assigned driver; kiểm tra aggregate version.',
  },
  'trip.completed': {
    code: 'EVT-07', producer: 'trip-booking-service', aggregate: 'trip', queues: [EVENT_QUEUES.NOTIFICATION],
    note: 'Thông báo cho passenger và assigned driver; kiểm tra aggregate version.',
  },
  'trip.cancelled': {
    code: 'EVT-08', producer: 'trip-booking-service', aggregate: 'trip',
    queues: [EVENT_QUEUES.MATCHING, EVENT_QUEUES.NOTIFICATION],
    note: 'affectedDriverIds có thể rỗng; Notification bổ sung recipient từ projection; không broadcast.',
  },
  'payment.requested': {
    code: 'EVT-09', producer: 'trip-booking-service', aggregate: 'trip', queues: [EVENT_QUEUES.PAYMENT],
    note: 'Trip COMPLETED mới phát; paymentId cố định theo trip; attempt mới khác transport retry.',
  },
  'payment.succeeded': {
    code: 'EVT-10', producer: 'simulated-payment-service', aggregate: 'payment',
    queues: [EVENT_QUEUES.TRIP, EVENT_QUEUES.NOTIFICATION],
    note: 'SUCCEEDED là terminal; event FAILED cũ không làm lùi trạng thái.',
  },
  'payment.failed': {
    code: 'EVT-11', producer: 'simulated-payment-service', aggregate: 'payment',
    queues: [EVENT_QUEUES.TRIP, EVENT_QUEUES.NOTIFICATION],
    note: 'Trip điều phối tối đa 3 attempt; Notification ghi kết quả, không tự hủy Trip.',
  },
};

export const EVENT_TYPES = Object.keys(EVENT_CATALOG) as EventType[];

export function isEventType(value: unknown): value is EventType {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(EVENT_CATALOG, value);
}

/** Routing key mà một queue phải bind trên ride.events. */
export function eventTypesForQueue(queue: EventQueue): EventType[] {
  return EVENT_TYPES.filter(type => EVENT_CATALOG[type].queues.includes(queue));
}
