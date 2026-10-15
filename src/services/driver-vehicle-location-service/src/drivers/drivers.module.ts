import { Module } from '@nestjs/common';
import { DriversController } from './drivers.controller';
import { VehiclesController } from './vehicles.controller';
import { LocationsController } from './locations.controller';
import { DriversInternalController } from './drivers-internal.controller';
import { ReservationsInternalController } from './reservations-internal.controller';
import { DriversService } from './drivers.service';
import { VehiclesService } from './vehicles.service';
import { LocationsService } from './locations.service';
import { ReservationsService } from './reservations.service';
import { ReservationExpiryWorker } from './reservation-expiry.worker';

// TODO: đăng ký DB driver_schema, entity/repository, auth guard, readiness và migration runner khi implementation sẵn sàng.

@Module({
  controllers: [DriversController, VehiclesController, LocationsController, DriversInternalController, ReservationsInternalController],
  providers: [DriversService, VehiclesService, LocationsService, ReservationsService, ReservationExpiryWorker],
})
export class DriversModule {}
