import { Injectable, NotImplementedException } from '@nestjs/common';
import { DriverProfileDto } from './dto/driver-profile.dto';
import { AvailabilityDto } from './dto/availability.dto';


@Injectable()
export class DriversService {
  upsertProfile(driverId: string, dto: DriverProfileDto): never {
    // TODO: lấy driverId từ actor verified; upsert profile không reset availability.
    throw new NotImplementedException('DriversService.upsertProfile TODO');
  }

  getProfile(driverId: string): never {
    // TODO: đọc profile/effective status/version/GPS sequence; chưa GPS trả sequence=0.
    throw new NotImplementedException('DriversService.getProfile TODO');
  }

  updateAvailability(driverId: string, dto: AvailabilityDto, idempotencyKey: string): never {
    // TODO: replay key trước expectedVersion; ONLINE đủ xe/GPS; OFFLINE chặn active reservation.
    throw new NotImplementedException('DriversService.updateAvailability TODO');
  }
}
