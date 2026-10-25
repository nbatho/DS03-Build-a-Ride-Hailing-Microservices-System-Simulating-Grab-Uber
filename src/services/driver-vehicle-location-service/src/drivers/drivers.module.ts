import { Module } from '@nestjs/common';
import { DriversController } from './drivers.controller';
import { DriversService } from './drivers.service';
import { DriverStateService } from './driver-state.service';

// Hồ sơ và bật/tắt nhận chuyến (API-04, 05, 08).

@Module({
  controllers: [DriversController],
  providers: [DriversService, DriverStateService],
  exports: [DriverStateService],
})
export class DriversModule {}
