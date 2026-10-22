import { Injectable, Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ReadinessRegistry } from '@app/runtime';
import { databaseOptions } from './options';

// Sẵn sàng khi kết nối đúng payment_db bằng payment_app và migration đã tạo bảng.
@Injectable()
class PaymentReadiness implements OnModuleInit {
  constructor(
    private readonly database: DataSource,
    private readonly registry: ReadinessRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.add(async () => {
      const rows = await this.database.query(
        "SELECT current_user AS role, to_regclass('payment_schema.payments') AS payments, " +
          "to_regclass('payment_schema.outbox_events') AS outbox",
      );

      if (rows[0]?.role !== 'payment_app' || !rows[0]?.payments || !rows[0]?.outbox) {
        throw new Error('Payment database not ready');
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
  providers: [PaymentReadiness],
})
export class PaymentDatabaseModule {}
