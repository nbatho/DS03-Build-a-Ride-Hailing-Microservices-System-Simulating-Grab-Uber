import { Controller } from '@nestjs/common';
import { OffersService } from './offers.service';
import { OfferDecisionDto } from './dto/offer-decision.dto';
import { OfferResolutionDto } from './dto/offer-resolution.dto';

// TODO: Thêm định tuyến HTTP, xác thực và xử lý dữ liệu đầu vào.
// TODO: Xác thực service gọi và cấu hình prefix riêng cho route nội bộ.
@Controller('internal/v1/offers')
export class OffersInternalController {
  constructor(private readonly service: OffersService) {}

  // TODO: Tạo API đọc offer để Trip kiểm tra trước khi xử lý quyết định.
  getOffer(offerId: string): never {
    return this.service.getOffer(offerId);
  }

  // TODO: Tạo API nhận quyết định chấp nhận hoặc từ chối offer từ Trip.
  decideOffer(offerId: string, dto: OfferDecisionDto): never {
    return this.service.decideOffer(offerId, dto);
  }

  // TODO: Tạo API nhận kết quả Saga để kết thúc claim của offer.
  resolveOffer(offerId: string, dto: OfferResolutionDto): never {
    return this.service.resolveOffer(offerId, dto);
  }
}
