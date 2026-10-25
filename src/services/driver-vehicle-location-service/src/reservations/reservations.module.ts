import { Module } from '@nestjs/common';
import { ReservationsInternalController } from './reservations-internal.controller';
import { ReservationsService } from './reservations.service';
import { ReservationExpiryWorker } from './reservation-expiry.worker';
import { DriversModule } from '../drivers/drivers.module';

// Giữ, xem, xác nhận, trả xe cho Trip (API-11..14) và worker hết hạn giữ xe.

@Module({
  imports: [DriversModule],
  controllers: [ReservationsInternalController],
  providers: [ReservationsService, ReservationExpiryWorker],
})
export class ReservationsModule {}
