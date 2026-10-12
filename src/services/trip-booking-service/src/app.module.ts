import { Module } from '@nestjs/common';
import { RuntimeModule } from '@app/runtime';

@Module({
  imports: [RuntimeModule.forRoot('trip-booking-service')],
})
export class AppModule {}
