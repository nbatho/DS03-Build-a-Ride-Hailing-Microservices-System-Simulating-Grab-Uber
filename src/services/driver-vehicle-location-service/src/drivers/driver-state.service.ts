import { Injectable } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';
import type { DriverProfile } from '@app/contracts';
import { ApiError } from '@app/runtime';
import { DriverEntity } from './entities/driver.entity';
import { VehicleEntity } from '../vehicles/entities/vehicle.entity';
import { LatestLocationEntity } from '../locations/entities/latest-location.entity';
import { ReservationEntity } from '../reservations/entities/reservation.entity';
import { driverStatus, isLocationFresh } from './driver-status';

@Injectable()
export class DriverStateService {
  async now(manager: EntityManager): Promise<Date> {
    const [row] = (await manager.query('SELECT clock_timestamp() AS now')) as Array<{ now: Date }>;

    return row.now;
  }

  async lockDriver(
    manager: EntityManager,
    driverId: string,
    missingStatus = 404,
  ): Promise<DriverEntity> {
    const driver = await manager.getRepository(DriverEntity).findOne({
      where: { id: driverId },
      lock: { mode: 'pessimistic_write' },
    });

    if (!driver) {
      throw new ApiError(
        missingStatus,
        'DRIVER_NOT_ONBOARDED',
        'Driver profile has not been created',
      );
    }

    return driver;
  }

  async load(manager: EntityManager, driver: DriverEntity) {
    const location = await manager
      .getRepository(LatestLocationEntity)
      .findOneBy({ driverId: driver.id });
    const vehicle = await manager.getRepository(VehicleEntity).findOneBy({ driverId: driver.id });
    const active = await manager.getRepository(ReservationEntity).findOne({
      where: { driverId: driver.id, status: In(['HELD', 'CONFIRMED']) },
    });
    const now = await this.now(manager);
    const reservation =
      active?.status === 'HELD' && active.expiresAt!.getTime() <= now.getTime() ? null : active;
    const locationFresh = isLocationFresh(location?.receivedAt, now);
    const status = driverStatus(
      driver.online,
      Boolean(vehicle),
      locationFresh,
      reservation?.status,
    );

    return { location, vehicle, reservation, now, locationFresh, status };
  }

  async profile(manager: EntityManager, driver: DriverEntity): Promise<DriverProfile> {
    const state = await this.load(manager, driver);

    return {
      driverId: driver.id,
      licenseNumber: driver.licenseNumber,
      online: driver.online,
      status: state.status,
      locationFresh: state.locationFresh,
      locationSequence: state.location?.sequence ?? 0,
      version: driver.version,
    };
  }

  async saveDriver(manager: EntityManager, driver: DriverEntity): Promise<void> {
    driver.version++;
    driver.updatedAt = await this.now(manager);
    await manager.getRepository(DriverEntity).save(driver);
  }

  // Chỉ gọi sau lockDriver. Mọi luồng đều khóa tài xế trước, lượt giữ sau.
  async expireHeld(manager: EntityManager, driver: DriverEntity): Promise<void> {
    const held = await manager.getRepository(ReservationEntity).findOne({
      where: { driverId: driver.id, status: 'HELD' },
      lock: { mode: 'pessimistic_write' },
    });
    const now = await this.now(manager);

    if (held && held.expiresAt!.getTime() <= now.getTime()) {
      held.status = 'EXPIRED';
      held.version++;
      held.updatedAt = now;
      await manager.getRepository(ReservationEntity).save(held);
      await this.saveDriver(manager, driver);
    }
  }
}
