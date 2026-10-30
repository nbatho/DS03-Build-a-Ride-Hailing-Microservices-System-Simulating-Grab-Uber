import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { CurrentUser } from '@app/auth';
import type { Actor, Notification, NotificationsPage } from '@app/contracts';
import { uuidParam } from '@app/runtime';
import { ListNotificationsQueryDto, ReadNotificationDto } from './dto/notifications.dto';
import { NotificationsService } from './notifications.service';

// API-36, 37: khách và tài xế; người nhận luôn là sub trong JWT, không nhận recipientId từ client.
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentUser() actor: Actor, @Query() query: ListNotificationsQueryDto): Promise<NotificationsPage> {
    return this.notifications.list(actor.userId, query);
  }

  @Patch(':notificationId/read')
  markRead(
    @CurrentUser() actor: Actor,
    @Param('notificationId', uuidParam('notificationId')) notificationId: string,
    @Body() _body: ReadNotificationDto,
  ): Promise<Notification> {
    return this.notifications.markRead(actor.userId, notificationId);
  }
}
