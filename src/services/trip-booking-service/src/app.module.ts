import { Module } from '@nestjs/common';
import { AuthVerifierModule } from '@app/auth';
import { MessagingModule } from '@app/messaging';
import { RuntimeModule } from '@app/runtime';
import { TripDatabaseModule } from './database/database.module';
import { TripsModule } from './trips/trips.module';

@Module({
  imports: [
    RuntimeModule.forRoot('trip-booking-service'),
    TripDatabaseModule,
    MessagingModule.forRoot(),
    AuthVerifierModule,
    TripsModule,
  ],
})
export class AppModule {}
