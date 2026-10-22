import { DynamicModule, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MESSAGING_CONFIG, loadMessagingConfig } from './config';
import { EventConsumer } from './event-consumer';
import { EventPublisher } from './event-publisher';
import { RabbitConnection } from './rabbit-connection';

/**
 * Import sau RuntimeModule.forRoot() ở service dùng sự kiện. Readiness của service sẽ gồm cả RabbitMQ.
 * Thiếu RABBITMQ_URL thì dừng khi khởi động.
 */
@Module({})
export class MessagingModule {
  static forRoot(): DynamicModule {
    return {
      global: true,
      module: MessagingModule,
      providers: [
        {
          provide: MESSAGING_CONFIG,
          inject: [ConfigService],
          // ConfigService được inject để chắc .env đã nạp vào process.env.
          useFactory: (_config: ConfigService) => loadMessagingConfig(process.env),
        },
        RabbitConnection,
        EventPublisher,
        EventConsumer,
      ],
      exports: [MESSAGING_CONFIG, RabbitConnection, EventPublisher, EventConsumer],
    };
  }
}
