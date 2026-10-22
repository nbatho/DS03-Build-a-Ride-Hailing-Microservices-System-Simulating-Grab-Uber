import { Module } from '@nestjs/common';
import { AuthVerifierModule } from '@app/auth';
import { MessagingModule } from '@app/messaging';
import { RuntimeModule } from '@app/runtime';
import { NotificationDatabaseModule } from './database/database.module';
import { NotificationsModule } from './notifications/notifications.module';

@Module({
  imports: [
    RuntimeModule.forRoot('notification-service'),
    NotificationDatabaseModule,
    MessagingModule.forRoot(),
    AuthVerifierModule,
    NotificationsModule,
  ],
})
export class AppModule {}
