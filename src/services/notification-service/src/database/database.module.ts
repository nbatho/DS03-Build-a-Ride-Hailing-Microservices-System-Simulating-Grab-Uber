import { Injectable, Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ReadinessRegistry } from '@app/runtime';
import { databaseOptions } from './options';

// Sẵn sàng khi kết nối đúng notification_db bằng notification_app và migration đã tạo bảng.
@Injectable()
class NotificationReadiness implements OnModuleInit {
  constructor(
    private readonly database: DataSource,
    private readonly registry: ReadinessRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.add(async () => {
      const rows = await this.database.query(
        "SELECT current_user AS role, to_regclass('notification_schema.notifications') AS notifications, " +
          "to_regclass('notification_schema.trip_projection') AS projection",
      );

      if (rows[0]?.role !== 'notification_app' || !rows[0]?.notifications || !rows[0]?.projection) {
        throw new Error('Notification database not ready');
      }
    });
  }
}

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (_config: ConfigService) => ({
        ...databaseOptions(process.env),
        autoLoadEntities: true,
        retryAttempts: 1,
      }),
    }),
  ],
  providers: [NotificationReadiness],
})
export class NotificationDatabaseModule {}
