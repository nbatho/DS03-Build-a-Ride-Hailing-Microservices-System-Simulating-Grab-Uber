import { Module } from '@nestjs/common';
import { ReservationsInternalController } from './reservations-internal.controller';
import { ReservationsService } from './reservations.service';
import { ReservationExpiryWorker } from './reservation-expiry.worker';

// Giữ, xem, xác nhận, trả xe cho Trip (API-11..14) và worker hết hạn giữ xe.
// TODO: đăng ký entity/repository driver_schema.reservations khi có DataSource.

@Module({
  controllers: [ReservationsInternalController],
  providers: [ReservationsService, ReservationExpiryWorker],
})
export class ReservationsModule {}
