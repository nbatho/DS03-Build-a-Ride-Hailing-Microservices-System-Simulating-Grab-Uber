import { Controller } from '@nestjs/common';
import { LocationsService } from './locations.service';
import { LocationDto } from './dto/location.dto';

// TODO: Thêm định tuyến HTTP, xác thực và xử lý dữ liệu đầu vào.
// TODO: Xác thực JWT, kiểm tra role và lấy actor từ credential.
@Controller('drivers/me/location')
export class LocationsController {
  constructor(private readonly service: LocationsService) {}

  // TODO: Tạo API cập nhật GPS theo sequence.
  updateLocation(driverId: string, dto: LocationDto): never {
    return this.service.updateLocation(driverId, dto);
  }
}
