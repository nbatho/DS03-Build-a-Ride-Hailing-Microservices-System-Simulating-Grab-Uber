import { Injectable, type OnModuleInit } from '@nestjs/common';
import { EVENT_QUEUES } from '@app/contracts';
import { EventConsumer } from '@app/messaging';
import { PaymentsService } from './payments.service';

// Nhận payment.requested từ queue payment.events. Lỗi tạm thời (DB bận...) đi qua retry 1s/5s/15s;
// dữ liệu không khớp (NonRetryableEventError) vào payment.events.dlq.
@Injectable()
export class PaymentEventsConsumer implements OnModuleInit {
  constructor(
    private readonly consumer: EventConsumer,
    private readonly payments: PaymentsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.consumer.subscribe(EVENT_QUEUES.PAYMENT, {
      'payment.requested': async event => {
        await this.payments.handlePaymentRequested(event);
      },
    });
  }
}
