// Vỏ sự kiện (BA mục 8.1, Phụ lục C). Field của vỏ dùng snake_case; payload dùng camelCase.

export const RIDE_EVENTS_EXCHANGE = 'ride.events';
export const EVENT_SCHEMA_VERSION = 1;

export const EVENT_PRODUCERS = ['trip-booking-service', 'matching-service', 'simulated-payment-service'] as const;
export type EventProducer = typeof EVENT_PRODUCERS[number];

export interface EventEnvelope<TType extends string = string, TPayload = unknown> {
  /** Giữ nguyên khi gửi lại cùng sự kiện; lần thử nghiệp vụ mới thì mã mới. */
  event_id: string;
  /** Cũng là routing key trên exchange ride.events. */
  type: TType;
  schema_version: number;
  aggregate_id: string;
  aggregate_version: number;
  /** ISO-8601 UTC. */
  occurred_at: string;
  correlation_id: string;
  causation_id: string;
  producer: EventProducer;
  payload: TPayload;
}
