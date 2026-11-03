import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import {
  connect,
  type ChannelModel,
  type Channel,
  type ConfirmChannel,
  type ConsumeMessage,
  type Message,
  type Options,
} from 'amqplib';

interface PublishChannel {
  channel: ConfirmChannel;
  /** Lời gửi đang chờ xác nhận; channel đóng thì báo lỗi cho tất cả. */
  waiting: Set<(error: Error) => void>;
}

export const MATCHING_EXCHANGE = 'ride.events';
export const MATCHING_QUEUE = 'matching.events';
export const RETRY_DELAYS = [1000, 5000, 15000];

// Adapter local của Matching, có thể thay bằng @app/messaging khi C bàn giao.
@Injectable()
export class MatchingBroker implements OnApplicationShutdown {
  private connection?: ChannelModel;
  private consumerChannel?: Channel;
  private consumerTag?: string;
  private publishChannel?: Promise<PublishChannel>;
  /** messageId của tin bị trả về (mandatory, không queue nào nhận); RabbitMQ gửi return trước ack. */
  private readonly returned = new Set<string>();

  isReady(): boolean {
    return Boolean(this.connection && this.consumerChannel && this.consumerTag);
  }

  async consume(handler: (message: ConsumeMessage, channel: Channel) => void): Promise<void> {
    if (this.isReady()) {
      return;
    }

    await this.disconnect();
    const url = process.env.RABBITMQ_URL;

    if (!url || !['amqp:', 'amqps:'].includes(new URL(url).protocol)) {
      throw new Error('RABBITMQ_URL must be an AMQP URL');
    }

    const connection = await connect(url, { timeout: 3000 });

    this.connection = connection;
    connection.on('error', () =>
      Logger.warn('RabbitMQ connection error; will reconnect', 'MatchingBroker'),
    );
    connection.on('close', () => {
      if (this.connection === connection) {
        this.connection = undefined;
        this.consumerChannel = undefined;
        this.consumerTag = undefined;
      }
    });

    try {
      const channel = await connection.createChannel();

      channel.on('error', () => Logger.warn('RabbitMQ consumer channel error', 'MatchingBroker'));
      channel.on('close', () => {
        if (this.consumerChannel === channel) {
          this.consumerChannel = undefined;
          this.consumerTag = undefined;
        }
      });
      await channel.assertExchange(MATCHING_EXCHANGE, 'topic', { durable: true });
      await channel.assertQueue(MATCHING_QUEUE, { durable: true });
      await channel.bindQueue(MATCHING_QUEUE, MATCHING_EXCHANGE, 'trip.requested');
      await channel.bindQueue(MATCHING_QUEUE, MATCHING_EXCHANGE, 'trip.cancelled');
      await channel.assertQueue(MATCHING_QUEUE + '.dlq', { durable: true });

      for (const delay of RETRY_DELAYS) {
        await channel.assertQueue(MATCHING_QUEUE + '.retry.' + delay / 1000 + 's', {
          durable: true,
          messageTtl: delay,
          deadLetterExchange: '',
          deadLetterRoutingKey: MATCHING_QUEUE,
        });
      }

      await channel.prefetch(10);
      this.consumerChannel = channel;
      const subscription = await channel.consume(
        MATCHING_QUEUE,
        message => {
          if (message) {
            handler(message, channel);
          } else {
            this.consumerTag = undefined;
          }
        },
        { noAck: false },
      );

      this.consumerTag = subscription.consumerTag;
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }

  async stopConsuming(): Promise<void> {
    const tag = this.consumerTag;

    this.consumerTag = undefined;

    if (tag && this.consumerChannel) {
      await this.consumerChannel.cancel(tag).catch(() => {});
    }
  }

  async publish(
    exchange: string,
    routingKey: string,
    body: Buffer,
    properties: Options.Publish,
  ): Promise<void> {
    const connection = this.connection;

    if (!connection) {
      throw new Error('RabbitMQ is unavailable');
    }

    const { channel, waiting } = await this.confirmChannel(connection);
    const messageId = properties.messageId ?? randomUUID();

    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => {
        clearTimeout(timer);
        waiting.delete(fail);
        reject(error);
      };
      const timer = setTimeout(
        () => fail(new Error('RabbitMQ publish confirmation timed out')),
        5000,
      );

      waiting.add(fail);
      channel.publish(
        exchange,
        routingKey,
        body,
        { ...properties, messageId, persistent: true, mandatory: true },
        error => {
          clearTimeout(timer);
          waiting.delete(fail);

          if (this.returned.delete(messageId) || error) {
            reject(new Error('RabbitMQ publish was rejected or unroutable'));
          } else {
            resolve();
          }
        },
      );
    });
  }

  // Một confirm channel dùng lại cho mọi lần gửi: mở rồi đóng channel cho từng tin làm RabbitMQ tốn CPU khi tải cao.
  private confirmChannel(connection: ChannelModel): Promise<PublishChannel> {
    if (this.publishChannel) {
      return this.publishChannel;
    }

    const opening = connection.createConfirmChannel().then(
      channel => {
        const waiting = new Set<(error: Error) => void>();

        channel.on('error', () => {});
        channel.on('return', (message: Message) => {
          if (message.properties.messageId) {
            this.returned.add(message.properties.messageId as string);
          }
        });
        channel.on('close', () => {
          if (this.publishChannel === opening) {
            this.publishChannel = undefined;
          }

          for (const fail of [...waiting]) {
            fail(new Error('RabbitMQ channel closed before confirmation'));
          }
        });

        return { channel, waiting };
      },
      (error: unknown) => {
        if (this.publishChannel === opening) {
          this.publishChannel = undefined;
        }

        throw error;
      },
    );

    this.publishChannel = opening;

    return opening;
  }

  async disconnect(): Promise<void> {
    const connection = this.connection;

    this.publishChannel = undefined;
    this.connection = undefined;
    this.consumerChannel = undefined;
    this.consumerTag = undefined;
    await connection?.close().catch(() => {});
  }

  async onApplicationShutdown(): Promise<void> {
    await this.disconnect();
  }
}
