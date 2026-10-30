import { Injectable, type OnModuleInit } from '@nestjs/common';
import { EVENT_QUEUES } from '@app/contracts';
import { EventConsumer, type EventHandlers } from '@app/messaging';
import { NOTIFICATION_EVENT_TYPES, type NotificationEvent } from './notification-rules';
import { NotificationsService } from './notifications.service';

// Nhận 8 loại sự kiện từ queue notification.events (Phụ lục C). Notification chỉ nhận, không phát sự kiện.
@Injectable()
export class NotificationEventsConsumer implements OnModuleInit {
  constructor(
    private readonly consumer: EventConsumer,
    private readonly notifications: NotificationsService,
  ) {}

  async onModuleInit(): Promise<void> {
    const handle = async (event: NotificationEvent): Promise<void> => {
      await this.notifications.handleEvent(event);
    };
    const handlers = Object.fromEntries(NOTIFICATION_EVENT_TYPES.map(type => [type, handle])) as EventHandlers;

    await this.consumer.subscribe(EVENT_QUEUES.NOTIFICATION, handlers);
  }
}
