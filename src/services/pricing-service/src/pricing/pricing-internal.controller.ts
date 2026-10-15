import { Controller } from '@nestjs/common';
import { PricingService } from './pricing.service';

// TODO: Thêm định tuyến HTTP, xác thực và xử lý dữ liệu đầu vào.
// TODO: Xác thực service gọi và cấu hình prefix riêng cho route nội bộ.
@Controller('internal/v1/quotes')
export class PricingInternalController {
  constructor(private readonly service: PricingService) {}

  // TODO: Tạo API đọc báo giá nội bộ, chỉ cho phép Trip gọi.
  getQuoteForTrip(quoteId: string): never {
    return this.service.getQuoteForTrip(quoteId);
  }
}
