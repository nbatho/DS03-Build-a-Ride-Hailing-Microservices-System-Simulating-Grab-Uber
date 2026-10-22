import type { Channel } from 'amqplib';
import {
  EVENT_QUEUES,
  RIDE_EVENTS_EXCHANGE,
  eventTypesForQueue,
  type EventQueue,
  type EventType,
} from '@app/contracts';

// Exchange, queue, binding dựng từ EVENT_CATALOG (Phụ lục C, BA mục 8.1, 15.2).
// Mỗi queue gốc có ba queue chờ thử lại 1s/5s/15s và một queue lỗi: <tên>.retry.1s, .retry.5s, .retry.15s, .dlq.

export const RETRY_DELAYS_MS = [1_000, 5_000, 15_000] as const;
/** Số lần thử lại sau lần xử lý đầu tiên; hết thì vào DLQ. */
export const MAX_DELIVERY_RETRIES = RETRY_DELAYS_MS.length;

export interface RetryQueue {
  name: string;
  delayMs: number;
}

export interface QueueTopology {
  name: EventQueue;
  bindings: EventType[];
  retryQueues: RetryQueue[];
  deadLetterQueue: string;
}

export interface Topology {
  exchange: string;
  queues: QueueTopology[];
}

export const ALL_EVENT_QUEUES = Object.values(EVENT_QUEUES) as EventQueue[];

export function retryQueueName(queue: EventQueue, retryIndex: number): string {
  const delayMs = RETRY_DELAYS_MS[retryIndex];

  if (delayMs === undefined) {
    throw new RangeError('No retry queue for index ' + retryIndex);
  }

  return queue + '.retry.' + delayMs / 1000 + 's';
}

export function deadLetterQueueName(queue: EventQueue): string {
  return queue + '.dlq';
}

export function isEventQueue(value: string): value is EventQueue {
  return (ALL_EVENT_QUEUES as string[]).includes(value);
}

export function describeTopology(): Topology {
  return {
    exchange: RIDE_EVENTS_EXCHANGE,
    queues: ALL_EVENT_QUEUES.map(name => ({
      name,
      bindings: eventTypesForQueue(name),
      retryQueues: RETRY_DELAYS_MS.map((delayMs, index) => ({
        name: retryQueueName(name, index),
        delayMs,
      })),
      deadLetterQueue: deadLetterQueueName(name),
    })),
  };
}

/**
 * Khai báo toàn bộ topology; chạy lại nhiều lần không lỗi miễn là tham số không đổi.
 * Mọi service gọi trước khi gửi để tin mandatory luôn có queue nhận.
 */
export async function assertTopology(
  channel: Channel,
  topology: Topology = describeTopology(),
): Promise<void> {
  await channel.assertExchange(topology.exchange, 'topic', { durable: true });
  for (const queue of topology.queues) {
    await channel.assertQueue(queue.name, { durable: true });
    for (const type of queue.bindings) {
      await channel.bindQueue(queue.name, topology.exchange, type);
    }

    for (const retry of queue.retryQueues) {
      // Hết TTL thì RabbitMQ chuyển tin qua default exchange về đúng queue gốc, không đi lại ride.events
      // (nếu không mọi bên nhận khác cũng nhận lại).
      await channel.assertQueue(retry.name, {
        durable: true,
        arguments: {
          'x-message-ttl': retry.delayMs,
          'x-dead-letter-exchange': '',
          'x-dead-letter-routing-key': queue.name,
        },
      });
    }

    await channel.assertQueue(queue.deadLetterQueue, { durable: true });
  }
}
