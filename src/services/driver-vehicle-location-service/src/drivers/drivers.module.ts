import { Module } from '@nestjs/common';
import { DriversController } from './drivers.controller';
import { DriversService } from './drivers.service';

// Hồ sơ và bật/tắt nhận chuyến (API-04, 05, 08).
// TODO: đăng ký entity/repository driver_schema.drivers khi có DataSource.

@Module({
  controllers: [DriversController],
  providers: [DriversService],
})
export class DriversModule {}
