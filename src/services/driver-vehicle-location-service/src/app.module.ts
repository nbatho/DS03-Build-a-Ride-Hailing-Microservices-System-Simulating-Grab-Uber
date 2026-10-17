import { Module } from '@nestjs/common';
import { RuntimeModule } from '@app/runtime';
import { AuthVerifierModule } from '@app/auth';
import { DriversModule } from './drivers/drivers.module';
@Module({
  imports: [RuntimeModule.forRoot('driver-vehicle-location-service'), AuthVerifierModule, DriversModule],
})
export class AppModule {}
