import { Injectable, Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ReadinessRegistry } from '@app/runtime';
import { databaseOptions } from './options';

@Injectable()
class PricingReadiness implements OnModuleInit {
  constructor(
    private readonly database: DataSource,
    private readonly registry: ReadinessRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.add(async () => {
      const [row] = await this.database.query(
        'SELECT current_user AS role, current_database() AS database',
      );

      if (row?.role !== 'pricing_app' || row?.database !== 'pricing_db') {
        throw new Error('Pricing database not ready');
      }

      await this.database.query('SELECT rule_version FROM pricing_schema.fare_rules LIMIT 0');
      await this.database.query('SELECT id FROM pricing_schema.quotes LIMIT 0');
      await this.database.query('SELECT key FROM pricing_schema.idempotency_keys LIMIT 0');
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
  providers: [PricingReadiness],
})
export class PricingDatabaseModule {}
