import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { DriverProfile } from '@app/contracts';
import { ApiError, runInTransaction, withIdempotencyKey } from '@app/runtime';
import { throwDriverError } from '../common/database-error';
import { DriverEntity } from './entities/driver.entity';
import { DriverStateService } from './driver-state.service';
import { DriverProfileDto } from './dto/driver-profile.dto';
import { AvailabilityDto } from './dto/availability.dto';

@Injectable()
export class DriversService {
  constructor(
    private readonly database: DataSource,
    private readonly state: DriverStateService,
  ) {}

  async upsertProfile(driverId: string, dto: DriverProfileDto): Promise<DriverProfile> {
    try {
      return await runInTransaction(this.database, async manager => {
        // Insert nếu chưa có; không reset online/version của hồ sơ đã tồn tại.
        await manager
          .createQueryBuilder()
          .insert()
          .into(DriverEntity)
          .values({ id: driverId, licenseNumber: dto.licenseNumber })
          .orIgnore()
          .execute();
        const driver = await this.state.lockDriver(manager, driverId);

        if (driver.licenseNumber !== dto.licenseNumber) {
          driver.licenseNumber = dto.licenseNumber;
          await this.state.saveDriver(manager, driver);
        }

        return this.state.profile(manager, driver);
      });
    } catch (error) {
      throwDriverError(error);
    }
  }

  async getProfile(driverId: string): Promise<DriverProfile> {
    try {
      return await runInTransaction(this.database, async manager => {
        const driver = await this.state.lockDriver(manager, driverId);

        return this.state.profile(manager, driver);
      });
    } catch (error) {
      throwDriverError(error);
    }
  }

  async updateAvailability(
    driverId: string,
    dto: AvailabilityDto,
    idempotencyKey: string,
  ): Promise<DriverProfile> {
    try {
      const result = await withIdempotencyKey(
        this.database,
        {
          schema: 'driver_schema',
          actorId: driverId,
          method: 'PATCH',
          path: '/api/v1/drivers/me/status',
          key: idempotencyKey,
        },
        dto,
        async manager => {
          const driver = await this.state.lockDriver(manager, driverId);

          if (driver.version !== dto.expectedVersion) {
            throw new ApiError(
              409,
              'VERSION_CONFLICT',
              'Driver version has changed; read the profile again',
            );
          }

          await this.state.expireHeld(manager, driver);

          const state = await this.state.load(manager, driver);

          if (!dto.online && state.reservation) {
            throw new ApiError(409, 'ACTIVE_RESERVATION', 'Driver has an active reservation');
          }

          if (dto.online && !state.vehicle) {
            throw new ApiError(404, 'VEHICLE_NOT_FOUND', 'Register a vehicle before going online');
          }

          if (dto.online && !state.locationFresh) {
            throw new ApiError(
              409,
              'LOCATION_STALE',
              'Send a fresh GPS location before going online',
            );
          }

          if (driver.online !== dto.online) {
            driver.online = dto.online;
            await this.state.saveDriver(manager, driver);
          }

          return { status: 200, body: await this.state.profile(manager, driver) };
        },
      );

      return result.body;
    } catch (error) {
      throwDriverError(error);
    }
  }
}
