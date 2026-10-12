import { Module } from '@nestjs/common';
import { RuntimeModule } from '@app/runtime';
import { NotificationsModule } from './notifications/notifications.module';

@Module({
  imports: [RuntimeModule.forRoot('notification-service'), NotificationsModule],
})
export class AppModule {}
