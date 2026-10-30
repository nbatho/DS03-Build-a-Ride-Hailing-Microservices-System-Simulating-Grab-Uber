import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxEvent, Payment, PaymentAttempt, ProcessedEvent } from './entities';
import { PaymentEventsConsumer } from './payment-events.consumer';
import { PaymentOutboxRelay } from './payment-outbox.relay';
import { loadSimulatorConfig } from './payment-simulator';
import { PaymentsController } from './payments.controller';
import { PaymentsInternalController } from './payments-internal.controller';
import { PAYMENT_SIMULATOR_CONFIG, PaymentsService } from './payments.service';

@Module({
  imports: [TypeOrmModule.forFeature([Payment, PaymentAttempt, ProcessedEvent, OutboxEvent])],
  controllers: [PaymentsController, PaymentsInternalController],
  providers: [
    {
      provide: PAYMENT_SIMULATOR_CONFIG,
      inject: [ConfigService],
      // ConfigService được inject để chắc .env đã nạp; cấu hình sai thì dừng khi khởi động.
      useFactory: (_config: ConfigService) => loadSimulatorConfig(process.env),
    },
    PaymentsService,
    PaymentEventsConsumer,
    PaymentOutboxRelay,
  ],
})
export class PaymentsModule {}
