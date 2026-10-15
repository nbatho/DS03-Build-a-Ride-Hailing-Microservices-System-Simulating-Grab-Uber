import { Controller } from '@nestjs/common';
import { PricingService } from './pricing.service';
import { CreateQuoteDto } from './dto/create-quote.dto';

// TODO: Thêm định tuyến HTTP, xác thực và xử lý dữ liệu đầu vào.
// TODO: Xác thực JWT, kiểm tra role và lấy actor từ credential.
@Controller('quotes')
export class PricingController {
  constructor(private readonly service: PricingService) {}

  // TODO: Tạo API tạo báo giá cho hành khách đã xác thực và kiểm tra khóa chống gửi lặp.
  createQuote(passengerId: string, dto: CreateQuoteDto, idempotencyKey: string): never {
    return this.service.createQuote(passengerId, dto, idempotencyKey);
  }

  // TODO: Tạo API đọc báo giá và kiểm tra hành khách sở hữu báo giá.
  getMyQuote(passengerId: string, quoteId: string): never {
    return this.service.getMyQuote(passengerId, quoteId);
  }
}
