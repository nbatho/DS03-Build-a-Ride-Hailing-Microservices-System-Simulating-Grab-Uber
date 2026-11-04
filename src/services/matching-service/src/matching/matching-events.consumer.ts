import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Channel, ConsumeMessage, MessagePropertyHeaders } from 'amqplib';
import { MAX_EVENT_BYTES } from '@app/contracts';
import {
  DLQ_TRUNCATED_BYTES,
  ERROR_CODE_HEADER,
  ERROR_MESSAGE_HEADER,
  RETRY_COUNT_HEADER,
} from '@app/messaging';
import { ApiError, ReadinessRegistry } from '@app/runtime';
import { MatchingBroker, MATCHING_QUEUE, RETRY_DELAYS } from './matching-broker';
import { MatchingService } from './matching.service';
import { readTripEvent } from './event-contracts';

@Injectable()
export class MatchingEventsConsumer implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private connecting?: Promise<void>;
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly broker: MatchingBroker,
    private readonly service: MatchingService,
    private readonly readiness: ReadinessRegistry,
  ) {}

  onModuleInit(): void {
    this.readiness.add(async () => {
      if (!this.broker.isReady()) {
        throw new Error('Matching RabbitMQ consumer is not ready');
      }
    });

    const reconnect = () => {
      if (!this.connecting && !this.broker.isReady()) {
        this.connecting = this.broker
          .consume((message, channel) => this.deliver(message, channel))
          .catch(() =>
            Logger.warn('RabbitMQ unavailable; reconnecting on the next tick', 'MatchingConsumer'),
          )
          .finally(() => {
            this.connecting = undefined;
          });
      }
    };

    this.timer = setInterval(reconnect, 1000);
    this.timer.unref();
    reconnect();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.connecting;
    await this.broker.stopConsuming();
    await Promise.allSettled([...this.pending]);
  }

  handleTripRequested(envelope: unknown): Promise<void> {
    return this.service.createJobFromRequested(envelope);
  }

  handleTripCancelled(envelope: unknown): Promise<void> {
    return this.service.cancelJobFromEvent(envelope);
  }

  private deliver(message: ConsumeMessage, channel: Channel): void {
    const task = this.process(message, channel)
      .catch(async () => {
        // Chưa ACK thì broker sẽ phát lại sau reconnect; tránh vòng lặp NACK nóng.
        await this.broker.disconnect();
      })
      .finally(() => {
        this.pending.delete(task);
      });

    this.pending.add(task);
  }

  private async process(message: ConsumeMessage, channel: Channel): Promise<void> {
    if (message.content.length > MAX_EVENT_BYTES) {
      await this.deadLetter(
        message,
        'EVENT_TOO_LARGE',
        'Event is ' + message.content.length + ' bytes, limit ' + MAX_EVENT_BYTES,
        message.content.subarray(0, DLQ_TRUNCATED_BYTES),
        { 'x-original-size': message.content.length, 'x-truncated': true },
      );
      channel.ack(message);

      return;
    }

    try {
      let body: unknown;

      try {
        body = JSON.parse(message.content.toString('utf8'));
      } catch {
        throw new ApiError(400, 'INVALID_EVENT', 'Invalid event JSON');
      }

      const event = readTripEvent(body);

      if (message.properties.messageId && message.properties.messageId !== event.event_id) {
        throw new ApiError(400, 'INVALID_EVENT', 'Message ID and event ID differ');
      }

      if (event.type === 'trip.requested') {
        await this.handleTripRequested(event);
      } else {
        await this.handleTripCancelled(event);
      }

      channel.ack(message); // Transaction đã commit trước ACK.
    } catch (error) {
      const permanent = error instanceof ApiError && error.getStatus() < 500;
      const attempts = retryCount(message.properties.headers);
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 500);

      if (!permanent && attempts < RETRY_DELAYS.length) {
        await this.broker.publish(
          '',
          MATCHING_QUEUE + '.retry.' + RETRY_DELAYS[attempts] / 1000 + 's',
          message.content,
          copyProperties(message, { [RETRY_COUNT_HEADER]: attempts + 1, 'x-last-error': reason }),
        );
      } else {
        await this.deadLetter(
          message,
          permanent ? errorCode(error) : 'RETRIES_EXHAUSTED',
          reason,
          message.content,
          { [RETRY_COUNT_HEADER]: attempts },
        );
      }

      channel.ack(message);
    }
  }

  private deadLetter(
    message: ConsumeMessage,
    code: string,
    reason: string,
    content: Buffer,
    headers: Record<string, unknown>,
  ): Promise<void> {
    Logger.error(
      MATCHING_QUEUE + ' -> DLQ ' + code + ': ' + reason + ' (message ' + (message.properties.messageId ?? '?') + ')',
      'MatchingConsumer',
    );

    return this.broker.publish(
      '',
      MATCHING_QUEUE + '.dlq',
      content,
      copyProperties(message, {
        ...headers,
        [ERROR_CODE_HEADER]: code,
        [ERROR_MESSAGE_HEADER]: reason,
        'x-original-queue': MATCHING_QUEUE,
        'x-failed-at': new Date().toISOString(),
      }),
    );
  }
}

function retryCount(headers: MessagePropertyHeaders | undefined): number {
  const value = Number(headers?.[RETRY_COUNT_HEADER] ?? headers?.['x-matching-retry'] ?? 0);

  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function errorCode(error: unknown): string {
  const body = error instanceof ApiError ? (error.getResponse() as { code?: string }) : undefined;

  return body?.code ?? 'INVALID_EVENT';
}

function copyProperties(message: ConsumeMessage, headers: Record<string, unknown>) {
  const { 'x-matching-retry': _legacy, ...original } = message.properties.headers ?? {};

  return {
    contentType: 'application/json',
    messageId: message.properties.messageId,
    correlationId: message.properties.correlationId,
    headers: { ...original, ...headers },
  };
}
