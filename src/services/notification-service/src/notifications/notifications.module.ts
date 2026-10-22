import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Notification, ProcessedEvent, TripProjection } from './entities';
import { NotificationEventsConsumer } from './notification-events.consumer';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Module({
  imports: [TypeOrmModule.forFeature([Notification, TripProjection, ProcessedEvent])],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationEventsConsumer],
})
export class NotificationsModule {}
