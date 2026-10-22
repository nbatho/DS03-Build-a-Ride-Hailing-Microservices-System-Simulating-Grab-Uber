import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  EVENT_CATALOG,
  EVENT_SCHEMA_VERSION,
  RIDE_EVENTS_EXCHANGE,
  assertRideEvent,
  type EventPayloads,
  type EventType,
  type RideEvent,
} from '@app/contracts';
import { RabbitConnection } from './rabbit-connection';

export interface CreateEventInput<T extends EventType> {
  aggregateId: string;
  aggregateVersion: number;
  correlationId: string;
  /** Mã của request/sự kiện gây ra sự kiện này. */
  causationId: string;
  payload: EventPayloads[T];
  /** Chỉ truyền khi dựng lại đúng sự kiện cũ; lần thử nghiệp vụ mới luôn có mã mới. */
  eventId?: string;
  occurredAt?: Date;
}

/** Dựng envelope đúng Phụ lục C (producer lấy từ catalog) và kiểm tra trước khi ghi outbox. */
export function createRideEvent<T extends EventType>(
  type: T,
  input: CreateEventInput<T>,
): RideEvent<T> {
  return assertRideEvent(
    {
      event_id: input.eventId ?? randomUUID(),
      type,
      schema_version: EVENT_SCHEMA_VERSION,
      aggregate_id: input.aggregateId,
      aggregate_version: input.aggregateVersion,
      occurred_at: (input.occurredAt ?? new Date()).toISOString(),
      correlation_id: input.correlationId,
      causation_id: input.causationId,
      producer: EVENT_CATALOG[type].producer,
      payload: input.payload,
    },
    type,
  );
}

/**
 * Gửi sự kiện lên ride.events, routing key = type. Service nghiệp vụ không gọi trực tiếp sau khi ghi DB:
 * ghi outbox trong transaction rồi để OutboxRelay gửi (BA mục 8.2). Gọi thẳng chỉ dành cho relay và script.
 */
@Injectable()
export class EventPublisher {
  constructor(private readonly connection: RabbitConnection) {}

  isReady(): boolean {
    return this.connection.isConnected();
  }

  async publish(input: unknown): Promise<RideEvent> {
    const event = assertRideEvent(input);

    await this.connection.publishConfirmed(
      RIDE_EVENTS_EXCHANGE,
      event.type,
      Buffer.from(JSON.stringify(event)),
      {
        messageId: event.event_id,
        correlationId: event.correlation_id,
        type: event.type,
        appId: event.producer,
        timestamp: Math.floor(Date.parse(event.occurred_at) / 1000),
        headers: { 'x-schema-version': event.schema_version },
      },
    );

    return event;
  }
}
