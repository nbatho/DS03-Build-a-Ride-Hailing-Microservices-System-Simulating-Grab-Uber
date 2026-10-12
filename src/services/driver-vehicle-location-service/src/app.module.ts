import { Module } from '@nestjs/common';
import { RuntimeModule } from '@app/runtime';
import { DriversModule } from './drivers/drivers.module';

@Module({
  imports: [RuntimeModule.forRoot('driver-vehicle-location-service'), DriversModule],
})
export class AppModule {}
