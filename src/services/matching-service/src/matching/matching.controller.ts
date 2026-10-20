import { Controller } from '@nestjs/common';
import { InternalRoute } from '@app/runtime';
import { MatchingService } from './matching.service';
import { CancelMatchingJobDto } from './dto/cancel-matching-job.dto';

// TODO: Thêm định tuyến HTTP, xác thực và xử lý dữ liệu đầu vào.
@InternalRoute('TRIP')
@Controller('internal/v1/matching/jobs')
export class MatchingController {
  constructor(private readonly service: MatchingService) {}

  // TODO: Tạo API đọc matching job theo tripId, chỉ cho phép Trip gọi.
  getJobByTripId(tripId: string): never {
    return this.service.getJobByTripId(tripId);
  }

  // TODO: Tạo API hủy matching job và kiểm tra phiên bản chuyến.
  cancelJob(tripId: string, dto: CancelMatchingJobDto): never {
    return this.service.cancelJob(tripId, dto);
  }
}
