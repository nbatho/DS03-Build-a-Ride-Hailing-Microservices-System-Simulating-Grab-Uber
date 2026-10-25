import { Module } from '@nestjs/common';
import { LocationsController } from './locations.controller';
import { DriversInternalController } from './drivers-internal.controller';
import { LocationsService } from './locations.service';
import { DriversModule } from '../drivers/drivers.module';

// GPS và tìm ứng viên cho Matching (API-09, 10).

@Module({
  imports: [DriversModule],
  controllers: [LocationsController, DriversInternalController],
  providers: [LocationsService],
})
export class LocationsModule {}
