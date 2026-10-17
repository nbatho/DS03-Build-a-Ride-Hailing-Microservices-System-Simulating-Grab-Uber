import { Controller, Get } from '@nestjs/common';
import { Roles } from '@app/auth';
import { ApiError } from '@app/runtime';
import { DriversService } from './drivers.service';
import { DriverProfileDto } from './dto/driver-profile.dto';
import { AvailabilityDto } from './dto/availability.dto';

// TODO: Thêm định tuyến HTTP và xử lý dữ liệu đầu vào; actor lấy bằng @CurrentUser().
@Controller('drivers')
@Roles('DRIVER')
export class DriversController {
  constructor(private readonly service: DriversService) {}

  // Placeholder của A, test Identity đang dựa vào 404 này.
  // TODO: Thay bằng getProfile (API-05) khi làm onboarding; báo A cập nhật test.
  @Get('me')
  me(): never {
    // Identity only creates accounts. B implements onboarding/profile persistence next.
    throw new ApiError(404, 'DRIVER_NOT_ONBOARDED', 'Driver profile has not been created');
  }

  // TODO: Tạo API cập nhật hồ sơ của tài xế đã xác thực.
  upsertProfile(driverId: string, dto: DriverProfileDto): never {
    return this.service.upsertProfile(driverId, dto);
  }

  // TODO: Tạo API đọc hồ sơ và trạng thái hiện tại của tài xế.
  getProfile(driverId: string): never {
    return this.service.getProfile(driverId);
  }

  // TODO: Tạo API bật hoặc tắt nhận chuyến, kiểm tra version và khóa chống gửi lặp.
  updateAvailability(driverId: string, dto: AvailabilityDto, idempotencyKey: string): never {
    return this.service.updateAvailability(driverId, dto, idempotencyKey);
  }
}
