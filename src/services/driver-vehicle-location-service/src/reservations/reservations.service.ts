import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import type { Reservation } from '@app/contracts';
import type { InternalCaller } from '@app/shared-types';
import { ApiError, withCommandResult } from '@app/runtime';
import { throwDriverError } from '../common/database-error';
import { DriverStateService } from '../drivers/driver-state.service';
import { ReservationEntity, toReservation } from './entities/reservation.entity';
import { ReserveReservationDto } from './dto/reserve-reservation.dto';
import { ConfirmReservationDto } from './dto/confirm-reservation.dto';
import { ReleaseReservationDto } from './dto/release-reservation.dto';

@Injectable()
export class ReservationsService {
  constructor(
    private readonly database: DataSource,
    private readonly state: DriverStateService,
  ) {}

  async reserve(
    reservationId: string,
    dto: ReserveReservationDto,
    caller: InternalCaller,
    correlationId: string,
  ): Promise<Reservation> {
    try {
      const result = await withCommandResult(
        this.database,
        {
          schema: 'driver_schema',
          callerService: caller,
          commandType: 'RESERVE',
          commandId: reservationId,
          resourceId: reservationId,
          correlationId,
        },
        dto,
        async manager => {
          const driver = await this.state.lockDriver(manager, dto.driverId, 409);

          await this.state.expireHeld(manager, driver);

          const existing = await this.lockReservation(manager, reservationId);

          if (existing) {
            if (
              existing.tripId !== dto.tripId ||
              existing.driverId !== dto.driverId ||
              (existing.offerId !== null && existing.offerId !== dto.offerId)
            ) {
              throw new ApiError(
                409,
                'IDEMPOTENCY_CONFLICT',
                'Reservation ID was used with another payload',
              );
            }

            if (existing.status === 'RELEASED' || existing.status === 'EXPIRED') {
              throw new ApiError(409, 'RESERVATION_CLOSED', 'Reservation cannot be reopened');
            }

            return { status: 200, body: toReservation(existing) };
          }

          const state = await this.state.load(manager, driver);

          if (state.status !== 'AVAILABLE') {
            throw new ApiError(409, 'DRIVER_UNAVAILABLE', 'Driver is not available');
          }

          const reservations = manager.getRepository(ReservationEntity);
          const reservation = reservations.create({
            id: reservationId,
            tripId: dto.tripId,
            driverId: driver.id,
            offerId: dto.offerId,
            status: 'HELD',
            expiresAt: new Date(state.now.getTime() + 30000),
            version: 1,
            releaseReason: null,
            createdAt: state.now,
            updatedAt: state.now,
          });

          await reservations.insert(reservation);
          await this.state.saveDriver(manager, driver);

          return { status: 200, body: toReservation(reservation) };
        },
      );

      return result.body;
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.getResponse() as { code?: string }).code === 'PAYLOAD_MISMATCH'
      ) {
        throw new ApiError(
          409,
          'IDEMPOTENCY_CONFLICT',
          'Reservation ID was used with another payload',
        );
      }

      throwDriverError(error);
    }
  }

  async getReservation(reservationId: string): Promise<Reservation> {
    try {
      const reservation = await this.database
        .getRepository(ReservationEntity)
        .findOneBy({ id: reservationId });

      if (!reservation) {
        throw new ApiError(404, 'RESERVATION_NOT_FOUND', 'Reservation not found');
      }

      return toReservation(reservation);
    } catch (error) {
      throwDriverError(error);
    }
  }

  async confirm(
    reservationId: string,
    dto: ConfirmReservationDto,
    caller: InternalCaller,
    correlationId: string,
  ): Promise<Reservation> {
    try {
      const result = await withCommandResult(
        this.database,
        {
          schema: 'driver_schema',
          callerService: caller,
          commandType: 'CONFIRM',
          commandId: dto.commandId,
          resourceId: reservationId,
          correlationId,
        },
        dto,
        async manager => {
          const driver = await this.state.lockDriver(manager, dto.driverId, 409);
          const reservation = await this.lockReservation(manager, reservationId);

          if (!reservation) {
            throw new ApiError(404, 'RESERVATION_NOT_FOUND', 'Reservation not found');
          }

          this.checkOwner(reservation, dto);

          // Lấy giờ DB sau khi đã khóa cả hai dòng; không dùng giờ bắt đầu transaction.
          const now = await this.state.now(manager);

          if (
            reservation.status === 'EXPIRED' ||
            (reservation.status === 'HELD' && reservation.expiresAt!.getTime() <= now.getTime())
          ) {
            throw new ApiError(409, 'RESERVATION_EXPIRED', 'Reservation has expired');
          }

          if (reservation.status === 'RELEASED') {
            throw new ApiError(409, 'RESERVATION_CLOSED', 'Reservation was released');
          }

          if (reservation.status === 'HELD') {
            reservation.status = 'CONFIRMED';
            reservation.expiresAt = null;
            reservation.version++;
            reservation.updatedAt = now;
            await manager.getRepository(ReservationEntity).save(reservation);
            await this.state.saveDriver(manager, driver);
          }

          return { status: 200, body: toReservation(reservation) };
        },
      );

      return result.body;
    } catch (error) {
      throwDriverError(error);
    }
  }

  async release(
    reservationId: string,
    dto: ReleaseReservationDto,
    caller: InternalCaller,
    correlationId: string,
  ): Promise<Reservation> {
    try {
      const result = await withCommandResult(
        this.database,
        {
          schema: 'driver_schema',
          callerService: caller,
          commandType: 'RELEASE',
          commandId: dto.commandId,
          resourceId: reservationId,
          correlationId,
        },
        dto,
        async manager => {
          const driver = await this.state.lockDriver(manager, dto.driverId, 409);
          const reservations = manager.getRepository(ReservationEntity);
          let reservation = await this.lockReservation(manager, reservationId);
          const now = await this.state.now(manager);

          if (!reservation) {
            // Trả xe đến trước giữ xe: lưu dấu đã trả để chặn lệnh giữ đến muộn.
            reservation = reservations.create({
              id: reservationId,
              tripId: dto.tripId,
              driverId: driver.id,
              offerId: null,
              status: 'RELEASED',
              expiresAt: null,
              releaseReason: dto.reason,
              version: 1,
              createdAt: now,
              updatedAt: now,
            });
            await reservations.insert(reservation);
          } else {
            this.checkOwner(reservation, dto);

            if (reservation.status === 'HELD' || reservation.status === 'CONFIRMED') {
              reservation.status = 'RELEASED';
              reservation.expiresAt = null;
              reservation.releaseReason = dto.reason;
              reservation.version++;
              reservation.updatedAt = now;
              await reservations.save(reservation);
              await this.state.saveDriver(manager, driver);
            }
          }

          return { status: 200, body: toReservation(reservation) };
        },
      );

      return result.body;
    } catch (error) {
      throwDriverError(error);
    }
  }

  private lockReservation(manager: EntityManager, id: string): Promise<ReservationEntity | null> {
    return manager
      .getRepository(ReservationEntity)
      .findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
  }

  private checkOwner(
    reservation: ReservationEntity,
    dto: { tripId: string; driverId: string },
  ): void {
    if (reservation.tripId !== dto.tripId || reservation.driverId !== dto.driverId) {
      throw new ApiError(409, 'PAYLOAD_MISMATCH', 'Reservation belongs to another trip or driver');
    }
  }
}
