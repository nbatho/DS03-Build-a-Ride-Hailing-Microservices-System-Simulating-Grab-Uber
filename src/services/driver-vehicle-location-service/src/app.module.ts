import { Module } from '@nestjs/common';
import { RuntimeModule } from '@app/runtime';
import { AuthVerifierModule } from '@app/auth';
import { DriversModule } from './drivers/drivers.module';
import { VehiclesModule } from './vehicles/vehicles.module';
import { LocationsModule } from './locations/locations.module';
import { ReservationsModule } from './reservations/reservations.module';
@Module({
  imports: [
    RuntimeModule.forRoot('driver-vehicle-location-service'),
    AuthVerifierModule,
    DriversModule,
    VehiclesModule,
    LocationsModule,
    ReservationsModule,
  ],
})
export class AppModule {}
