import { setTimeout as sleep } from 'node:timers/promises';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Channel, ChannelModel, ConsumeMessage, MessagePropertyHeaders } from 'amqplib';
import { validateRideEvent, type EventQueue, type EventType, type RideEvent } from '@app/contracts';
import { MESSAGING_CONFIG, type MessagingConfig } from './config';
import { RabbitConnection } from './rabbit-connection';
import { MAX_DELIVERY_RETRIES, deadLetterQueueName, retryQueueName } from './topology';

export const RETRY_COUNT_HEADER = 'x-retry-count';
export const ERROR_CODE_HEADER = 'x-error-code';
export const ERROR_MESSAGE_HEADER = 'x-error-message';

export interface DeliveryContext {
  queue: EventQueue;
  /** 1 cho lần xử lý đầu, tăng sau mỗi lần qua queue retry. */
  attempt: number;
  redelivered: boolean;
}

export type EventHandler<T extends EventType> = (
  event: RideEvent<T>,
  context: DeliveryContext,
) => Promise<void>;

export type EventHandlers = { [K in EventType]?: EventHandler<K> };

/** Lỗi không sửa được bằng cách thử lại (dữ liệu sai nghiệp vụ...): vào DLQ ngay. */
export class NonRetryableEventError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'NonRetryableEventError';
  }
}

export type DeliveryOutcome = 'ACKED' | 'RETRY_SCHEDULED' | 'DEAD_LETTERED' | 'REQUEUED';

/** Phần của RabbitConnection mà consumer cần; tách ra để test không cần broker. */
export interface ConfirmedSender {
  publishConfirmed: RabbitConnection['publishConfirmed'];
}

/**
 * Nhận sự kiện từ queue riêng của service (BA mục 8.1–8.2):
 * - handler tự ghi "đã xử lý" + nghiệp vụ trong một transaction (xem processEventOnce); ACK sau khi handler xong;
 * - lỗi tạm thời: gửi bản sao (cùng event_id) vào <queue>.retry.1s/5s/15s, chờ confirm rồi mới ACK bản gốc;
 * - sai cấu trúc, lỗi không thử lại được, hoặc hết 3 lần thử: gửi vào <queue>.dlq kèm mã lỗi, confirm rồi ACK;
 * - gửi bản sao thất bại: không ACK, trả tin về queue để nhận lại.
 */
@Injectable()
export class EventConsumer {
  private readonly logger = new Logger('EventConsumer');

  constructor(
    private readonly connection: RabbitConnection,
    @Inject(MESSAGING_CONFIG) private readonly config: MessagingConfig,
  ) {}

  /** Mở consumer trên mỗi kết nối (kể cả sau khi RabbitMQ khởi động lại). */
  subscribe(queue: EventQueue, handlers: EventHandlers): Promise<void> {
    return this.connection.addSetup(async (model: ChannelModel) => {
      const channel = await model.createChannel();

      channel.on('error', (error: Error) =>
        this.logger.warn(queue + ' channel error: ' + error.message),
      );

      await channel.prefetch(this.config.prefetch);
      await channel.consume(
        queue,
        message => {
          if (!message) {
            return;
          }

          // ack/nack trên channel đã đóng sẽ ném lỗi; broker tự trả tin về queue nên chỉ cần ghi log.
          handleDelivery(channel, this.connection, queue, handlers, message, this.logger).catch(
            (error: unknown) =>
              this.logger.warn(queue + ' delivery not settled: ' + errorText(error)),
          );
        },
        { noAck: false },
      );

      this.logger.log('Consuming ' + queue);
    });
  }
}

function retryCount(headers: MessagePropertyHeaders | undefined): number {
  const value = Number(headers?.[RETRY_COUNT_HEADER] ?? 0);

  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function copyOptions(message: ConsumeMessage, headers: MessagePropertyHeaders) {
  const { messageId, correlationId, type, appId, timestamp } = message.properties;
  const { 'x-publish-id': _publishId, ...originalHeaders } = message.properties.headers ?? {};

  return {
    messageId,
    correlationId,
    type,
    appId,
    timestamp,
    headers: { ...originalHeaders, ...headers },
  };
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

export async function handleDelivery(
  channel: Pick<Channel, 'ack' | 'nack'>,
  sender: ConfirmedSender,
  queue: EventQueue,
  handlers: EventHandlers,
  message: ConsumeMessage,
  logger: Pick<Logger, 'warn' | 'error'> = new Logger('EventConsumer'),
): Promise<DeliveryOutcome> {
  const retries = retryCount(message.properties.headers);

  const deadLetter = async (code: string, reason: string): Promise<DeliveryOutcome> => {
    logger.error(
      queue +
        ' -> DLQ ' +
        code +
        ': ' +
        reason +
        ' (message ' +
        (message.properties.messageId ?? '?') +
        ')',
    );

    try {
      await sender.publishConfirmed(
        '',
        deadLetterQueueName(queue),
        message.content,
        copyOptions(message, {
          [RETRY_COUNT_HEADER]: retries,
          [ERROR_CODE_HEADER]: code,
          [ERROR_MESSAGE_HEADER]: reason,
          'x-original-queue': queue,
          'x-failed-at': new Date().toISOString(),
        }),
      );
    } catch (error) {
      return requeue(error);
    }

    channel.ack(message);

    return 'DEAD_LETTERED';
  };

  const requeue = async (error: unknown): Promise<DeliveryOutcome> => {
    logger.warn(
      queue + ': could not publish retry/DLQ copy (' + errorText(error) + '), requeueing original',
    );

    // Chờ một chút để không quay vòng khi RabbitMQ đang lỗi; channel đã đóng thì broker tự trả tin về queue.
    await sleep(1_000);
    try {
      channel.nack(message, false, true);
    } catch {
      // channel đã đóng
    }

    return 'REQUEUED';
  };

  let parsed: unknown;

  try {
    parsed = JSON.parse(message.content.toString('utf8'));
  } catch {
    return deadLetter('INVALID_EVENT', 'Body is not valid JSON');
  }

  const validation = validateRideEvent(parsed);

  if (!validation.ok) {
    return deadLetter('INVALID_EVENT', validation.errors.join('; '));
  }

  const event = validation.event;
  const handler = handlers[event.type] as EventHandler<EventType> | undefined;

  if (!handler) {
    return deadLetter('UNHANDLED_EVENT_TYPE', queue + ' has no handler for ' + event.type);
  }

  try {
    await handler(event, { queue, attempt: retries + 1, redelivered: message.fields.redelivered });
  } catch (error) {
    if (error instanceof NonRetryableEventError) {
      return deadLetter(error.code, error.message);
    }

    if (retries >= MAX_DELIVERY_RETRIES) {
      return deadLetter('RETRIES_EXHAUSTED', errorText(error));
    }

    logger.warn(
      queue +
        ': ' +
        event.type +
        ' ' +
        event.event_id +
        ' failed (attempt ' +
        (retries + 1) +
        '): ' +
        errorText(error),
    );

    try {
      await sender.publishConfirmed(
        '',
        retryQueueName(queue, retries),
        message.content,
        copyOptions(message, {
          [RETRY_COUNT_HEADER]: retries + 1,
          'x-last-error': errorText(error),
        }),
      );
    } catch (publishError) {
      return requeue(publishError);
    }

    channel.ack(message);

    return 'RETRY_SCHEDULED';
  }

  channel.ack(message);

  return 'ACKED';
}
