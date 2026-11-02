import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Channel, ConsumeMessage } from 'amqplib';
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
    try {
      if (message.content.length > 65536) {
        throw new ApiError(400, 'INVALID_EVENT', 'Event exceeds 64 KiB');
      }

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
      const attempts = Number(message.properties.headers?.['x-matching-retry'] ?? 0);
      const retry =
        !permanent && Number.isInteger(attempts) && attempts >= 0 && attempts < RETRY_DELAYS.length;
      const queue = retry
        ? MATCHING_QUEUE + '.retry.' + RETRY_DELAYS[attempts] / 1000 + 's'
        : MATCHING_QUEUE + '.dlq';

      await this.broker.publish('', queue, message.content, {
        contentType: 'application/json',
        messageId: message.properties.messageId,
        correlationId: message.properties.correlationId,
        headers: {
          ...message.properties.headers,
          'x-matching-retry': retry ? attempts + 1 : attempts,
        },
      });
      channel.ack(message);
    }
  }
}
