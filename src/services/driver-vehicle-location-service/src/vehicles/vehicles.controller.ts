import { Controller } from '@nestjs/common';
import { VehiclesService } from './vehicles.service';
import { VehicleDto } from './dto/vehicle.dto';

// TODO: Thêm định tuyến HTTP, xác thực và xử lý dữ liệu đầu vào.
// TODO: Xác thực JWT, kiểm tra role và lấy actor từ credential.
@Controller('vehicles')
export class VehiclesController {
  constructor(private readonly service: VehiclesService) {}

  // TODO: Tạo API đăng ký xe và kiểm tra khóa chống gửi lặp.
  registerVehicle(driverId: string, dto: VehicleDto, idempotencyKey: string): never {
    return this.service.registerVehicle(driverId, dto, idempotencyKey);
  }

  // TODO: Tạo API đọc xe thuộc tài xế đã xác thực.
  getMyVehicle(driverId: string): never {
    return this.service.getMyVehicle(driverId);
  }
}
