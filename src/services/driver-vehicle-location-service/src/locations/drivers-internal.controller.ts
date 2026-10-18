import { Controller } from '@nestjs/common';
import { LocationsService } from './locations.service';
import { CandidatesQueryDto } from './dto/candidates-query.dto';

// TODO: Thêm định tuyến HTTP, xác thực và xử lý dữ liệu đầu vào.
// TODO: Xác thực service gọi và cấu hình prefix riêng cho route nội bộ.
@Controller('internal/v1/drivers')
export class DriversInternalController {
  constructor(private readonly service: LocationsService) {}

  // TODO: Tạo API lấy ứng viên đủ điều kiện, chỉ cho phép Matching gọi.
  findCandidates(query: CandidatesQueryDto): never {
    return this.service.findCandidates(query);
  }
}
