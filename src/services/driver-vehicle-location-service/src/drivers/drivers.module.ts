import { Module } from '@nestjs/common';
import { DriversController } from './drivers.controller';
import { DriversService } from './drivers.service';
import { DriverStateService } from './driver-state.service';


@Module({
  controllers: [DriversController],
  providers: [DriversService, DriverStateService],
  exports: [DriverStateService],
})
export class DriversModule {}
