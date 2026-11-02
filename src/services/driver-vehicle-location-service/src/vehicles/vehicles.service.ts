import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { Vehicle } from '@app/contracts';
import { ApiError, withIdempotencyKey } from '@app/runtime';
import { DriverStateService } from '../drivers/driver-state.service';
import { throwDriverError } from '../common/database-error';
import { VehicleEntity, toVehicle } from './entities/vehicle.entity';
import { VehicleDto } from './dto/vehicle.dto';

@Injectable()
export class VehiclesService {
  constructor(
    private readonly database: DataSource,
    private readonly state: DriverStateService,
  ) {}

  async registerVehicle(
    driverId: string,
    dto: VehicleDto,
    idempotencyKey: string,
  ): Promise<Vehicle> {
    try {
      const result = await withIdempotencyKey(
        this.database,
        {
          schema: 'driver_schema',
          actorId: driverId,
          method: 'POST',
          path: '/api/v1/vehicles',
          key: idempotencyKey,
        },
        dto,
        async manager => {
          const driver = await this.state.lockDriver(manager, driverId);
          const vehicles = manager.getRepository(VehicleEntity);

          if (await vehicles.existsBy({ driverId: driver.id })) {
            throw new ApiError(409, 'VEHICLE_EXISTS', 'Driver already has a vehicle');
          }

          const vehicle = vehicles.create({
            id: randomUUID(),
            driverId: driver.id,
            ...dto,
            vehicleType: 'CAR',
          });

          await vehicles.insert(vehicle);

          return { status: 201, body: toVehicle(vehicle) };
        },
      );

      return result.body;
    } catch (error) {
      throwDriverError(error);
    }
  }

  async getMyVehicle(driverId: string): Promise<Vehicle> {
    try {
      const vehicle = await this.database.getRepository(VehicleEntity).findOneBy({ driverId });

      if (!vehicle) {
        throw new ApiError(404, 'VEHICLE_NOT_FOUND', 'Vehicle not found');
      }

      return toVehicle(vehicle);
    } catch (error) {
      throwDriverError(error);
    }
  }
}
