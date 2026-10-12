import { Module } from '@nestjs/common';
import { RuntimeModule } from '@app/runtime';
import { TripsModule } from './trips/trips.module';

@Module({
  imports: [RuntimeModule.forRoot('trip-booking-service'), TripsModule],
})
export class AppModule {}
