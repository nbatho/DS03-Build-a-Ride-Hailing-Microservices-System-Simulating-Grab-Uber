import { Controller } from '@nestjs/common';
import { DriversService } from './drivers.service';
import { DriverProfileDto } from './dto/driver-profile.dto';
import { AvailabilityDto } from './dto/availability.dto';

// TODO: Thêm định tuyến HTTP, xác thực và xử lý dữ liệu đầu vào.
// TODO: Xác thực JWT, kiểm tra role và lấy actor từ credential.
@Controller('drivers')
export class DriversController {
  constructor(private readonly service: DriversService) {}

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
