import { Module } from '@nestjs/common';
import { LocationsController } from './locations.controller';
import { DriversInternalController } from './drivers-internal.controller';
import { LocationsService } from './locations.service';

// GPS và tìm ứng viên cho Matching (API-09, 10).
// TODO: đăng ký entity/repository driver_schema.latest_locations khi có DataSource.

@Module({
  controllers: [LocationsController, DriversInternalController],
  providers: [LocationsService],
})
export class LocationsModule {}
