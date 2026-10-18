import { Module } from '@nestjs/common';
import { VehiclesController } from './vehicles.controller';
import { VehiclesService } from './vehicles.service';

// Đăng ký và xem xe (API-06, 07).
// TODO: đăng ký entity/repository driver_schema.vehicles khi có DataSource.

@Module({
  controllers: [VehiclesController],
  providers: [VehiclesService],
})
export class VehiclesModule {}
