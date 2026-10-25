import { Injectable, Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ReadinessRegistry } from '@app/runtime';
import { databaseOptions } from './options';
import { DriverEntity } from '../drivers/entities/driver.entity';
import { VehicleEntity } from '../vehicles/entities/vehicle.entity';
import { LatestLocationEntity } from '../locations/entities/latest-location.entity';
import { ReservationEntity } from '../reservations/entities/reservation.entity';
import { IdempotencyKeyEntity } from '../common/entities/idempotency-key.entity';
import { CommandResultEntity } from '../common/entities/command-result.entity';

@Injectable()
class DriverReadiness implements OnModuleInit {
  constructor(
    private readonly database: DataSource,
    private readonly registry: ReadinessRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.add(async () => {
      const [row] = await this.database.query(
        'SELECT current_user AS role, current_database() AS database',
      );

      if (row?.role !== 'driver_app' || row?.database !== 'driver_db') {
        throw new Error('Driver database not ready');
      }

      for (const table of [
        'drivers',
        'vehicles',
        'latest_locations',
        'reservations',
        'idempotency_keys',
        'command_results',
      ]) {
        await this.database.query('SELECT 1 FROM driver_schema.' + table + ' LIMIT 0');
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
        entities: [
          DriverEntity,
          VehicleEntity,
          LatestLocationEntity,
          ReservationEntity,
          IdempotencyKeyEntity,
          CommandResultEntity,
        ],
        retryAttempts: 1,
      }),
    }),
  ],
  providers: [DriverReadiness],
})
export class DriverDatabaseModule {}
