import { Injectable, Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ReadinessRegistry } from '@app/runtime';
import { databaseOptions } from './options';

@Injectable()
class TripReadiness implements OnModuleInit {
  constructor(
    private readonly database: DataSource,
    private readonly registry: ReadinessRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.add(async () => {
      const rows = await this.database.query(
        "SELECT current_user AS role, to_regclass('trip_schema.trips') AS trips, " +
          "to_regclass('trip_schema.operations') AS operations, " +
          "to_regclass('trip_schema.outbox_events') AS outbox",
      );

      if (
        rows[0]?.role !== 'trip_app' ||
        !rows[0]?.trips ||
        !rows[0]?.operations ||
        !rows[0]?.outbox
      ) {
        throw new Error('Trip database not ready');
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
  providers: [TripReadiness],
})
export class TripDatabaseModule {}
