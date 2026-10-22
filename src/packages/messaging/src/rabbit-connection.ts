import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  connect,
  type ChannelModel,
  type ConfirmChannel,
  type ConsumeMessage,
  type Options,
} from 'amqplib';
import { ReadinessRegistry } from '@app/runtime';
import { MESSAGING_CONFIG, redactUrl, type MessagingConfig } from './config';
import { assertTopology } from './topology';

const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 15_000];
const PUBLISH_ID_HEADER = 'x-publish-id';
/** Giới hạn cho kết nối TCP + bắt tay AMQP. Không có thì lúc RabbitMQ đang khởi động lại, connect() có thể treo mãi. */
const CONNECT_TIMEOUT_MS = 10_000;
/** amqplib mặc định tắt heartbeat; bật để phát hiện kết nối chết im lặng. */
const DEFAULT_HEARTBEAT_SECONDS = 10;
const CLOSE_TIMEOUT_MS = 3_000;

/** Thêm heartbeat vào URL nếu người cấu hình chưa đặt. */
export function withHeartbeat(url: string): string {
  const parsed = new URL(url);

  if (!parsed.searchParams.has('heartbeat')) {
    parsed.searchParams.set('heartbeat', String(DEFAULT_HEARTBEAT_SECONDS));
  }

  return parsed.toString();
}

/** Đóng kết nối nhưng không chờ quá CLOSE_TIMEOUT_MS (server đã mất thì close-ok không bao giờ tới). */
async function closeQuietly(model: ChannelModel): Promise<void> {
  let timer: NodeJS.Timeout | undefined;

  await Promise.race([
    model.close().catch(() => undefined),
    new Promise<void>(resolve => {
      timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
    }),
  ]);

  clearTimeout(timer);
}

export class MessagingUnavailableError extends Error {
  constructor(message = 'RabbitMQ is not connected') {
    super(message);
    this.name = 'MessagingUnavailableError';
  }
}

/** Tin bị RabbitMQ trả lại vì không có queue nào nhận (mandatory). Không được đánh dấu đã gửi. */
export class UnroutableMessageError extends Error {
  constructor(
    readonly exchange: string,
    readonly routingKey: string,
    readonly replyText: string,
  ) {
    super(
      'Message returned by broker (' +
        replyText +
        ') for ' +
        (exchange || '<default>') +
        '/' +
        routingKey,
    );

    this.name = 'UnroutableMessageError';
  }
}

/** Chạy lại sau mỗi lần kết nối (lần đầu và sau khi RabbitMQ khởi động lại). */
export type ConnectionSetup = (model: ChannelModel) => Promise<void>;

/**
 * Một kết nối amqplib cho mỗi service: tự kết nối lại, dựng topology, giữ một confirm channel để gửi.
 * Service vẫn khởi động khi RabbitMQ chưa chạy; readiness báo chưa sẵn sàng tới khi kết nối được.
 */
@Injectable()
export class RabbitConnection implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('RabbitConnection');

  private readonly setups: ConnectionSetup[] = [];

  private model?: ChannelModel;

  private publishChannel?: ConfirmChannel;

  private returned = new Set<string>();

  private reconnectTimer?: NodeJS.Timeout;

  private reconnectAttempt = 0;

  private stopping = false;

  private connecting = false;

  constructor(
    @Inject(MESSAGING_CONFIG) private readonly config: MessagingConfig,
    @Optional() readiness?: ReadinessRegistry,
  ) {
    readiness?.add(async () => {
      if (!this.isConnected()) {
        throw new MessagingUnavailableError();
      }
    });
  }

  onModuleInit(): void {
    void this.connectNow();
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  isConnected(): boolean {
    return this.model !== undefined && this.publishChannel !== undefined;
  }

  /** Đăng ký việc cần làm trên mỗi kết nối mới (ví dụ mở consumer). Đang kết nối thì chạy luôn. */
  async addSetup(setup: ConnectionSetup): Promise<void> {
    this.setups.push(setup);
    if (this.model) {
      await setup(this.model);
    }
  }

  /** Kết nối một lần, ném lỗi nếu không được; dùng cho script và test. Ứng dụng Nest dùng onModuleInit. */
  async connectOnce(): Promise<void> {
    if (this.isConnected()) {
      return;
    }

    await this.open();
  }

  async close(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.reconnectTimer);
    const model = this.model;

    this.reset();
    if (model) {
      await closeQuietly(model);
    }
  }

  /**
   * Gửi qua confirm channel với mandatory. Chỉ resolve khi RabbitMQ xác nhận và tin không bị trả lại.
   * Xác nhận này chỉ có nghĩa RabbitMQ đã nhận tin, không có nghĩa bên nhận đã xử lý xong.
   */
  publishConfirmed(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options: Options.Publish = {},
  ): Promise<void> {
    const channel = this.publishChannel;

    if (!channel) {
      return Promise.reject(new MessagingUnavailableError());
    }

    const publishId = randomUUID();
    const returned = this.returned;

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        returned.delete(publishId);
        reject(new MessagingUnavailableError('Timed out waiting for publisher confirm'));
      }, this.config.publishTimeoutMs);
      const settle = (error?: Error): void => {
        clearTimeout(timer);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      try {
        channel.publish(
          exchange,
          routingKey,
          content,
          {
            contentType: 'application/json',
            contentEncoding: 'utf-8',
            ...options,
            persistent: true,
            mandatory: true,
            headers: { ...options.headers, [PUBLISH_ID_HEADER]: publishId },
          },
          (error: unknown) => {
            // RabbitMQ gửi basic.return trước basic.ack trên cùng channel, nên lúc này đã biết tin có bị trả lại không.
            const wasReturned = returned.delete(publishId);

            if (error) {
              settle(error instanceof Error ? error : new Error(String(error)));
            } else if (wasReturned) {
              settle(new UnroutableMessageError(exchange, routingKey, 'NO_ROUTE'));
            } else {
              settle();
            }
          },
        );
      } catch (error) {
        settle(error as Error);
      }
    });
  }

  private async connectNow(): Promise<void> {
    if (this.connecting || this.stopping || this.isConnected()) {
      return;
    }

    this.connecting = true;
    try {
      await this.open();
      this.reconnectAttempt = 0;
    } catch (error) {
      this.reset();
      this.scheduleReconnect(error);
    } finally {
      this.connecting = false;
    }
  }

  private async open(): Promise<void> {
    this.stopping = false;
    const model = await connect(withHeartbeat(this.config.url), { timeout: CONNECT_TIMEOUT_MS });

    model.on('error', (error: Error) =>
      this.logger.warn('RabbitMQ connection error: ' + error.message),
    );

    model.on('close', () => {
      if (this.model !== model) {
        return;
      }

      this.reset();
      if (!this.stopping) {
        this.scheduleReconnect(new Error('connection closed'));
      }
    });

    try {
      const channel = await model.createConfirmChannel();

      channel.on('error', (error: Error) =>
        this.logger.warn('RabbitMQ publish channel error: ' + error.message),
      );

      channel.on('return', (message: ConsumeMessage) => {
        const publishId = message.properties.headers?.[PUBLISH_ID_HEADER];

        if (typeof publishId === 'string') {
          this.returned.add(publishId);
        }
      });

      channel.on('close', () => {
        // Channel gửi đóng riêng (ví dụ lỗi giao thức): đóng cả kết nối để dựng lại sạch.
        if (this.publishChannel === channel && !this.stopping) {
          void model.close().catch(() => undefined);
        }
      });

      await assertTopology(channel);
      this.model = model;
      this.publishChannel = channel;
      this.returned = new Set();
      for (const setup of this.setups) {
        await setup(model);
      }

      this.logger.log('Connected to ' + redactUrl(this.config.url));
    } catch (error) {
      this.model = undefined;
      this.publishChannel = undefined;
      await closeQuietly(model);
      throw error;
    }
  }

  private reset(): void {
    this.model = undefined;
    this.publishChannel = undefined;
    this.returned = new Set();
  }

  private scheduleReconnect(error: unknown): void {
    if (this.stopping || this.reconnectTimer) {
      return;
    }

    const delay =
      RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];

    this.reconnectAttempt += 1;
    this.logger.warn(
      'RabbitMQ unavailable (' + (error as Error).message + '), reconnecting in ' + delay + 'ms',
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connectNow();
    }, delay);

    this.reconnectTimer.unref?.();
  }
}
