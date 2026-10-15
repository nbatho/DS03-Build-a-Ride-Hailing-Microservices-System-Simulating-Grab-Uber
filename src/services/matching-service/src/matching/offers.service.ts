import { Injectable, NotImplementedException } from '@nestjs/common';
import { OfferDecisionDto } from './dto/offer-decision.dto';
import { OfferResolutionDto } from './dto/offer-resolution.dto';

@Injectable()
export class OffersService {
  getOffer(offerId: string): never {
    // TODO: trả owner/trip/status/expiry/version để Trip xác minh.
    throw new NotImplementedException('OffersService.getOffer TODO');
  }

  decideOffer(offerId: string, dto: OfferDecisionDto): never {
    // TODO: replay assignment/action; khóa job rồi offer; OPEN còn hạn -> CLAIMED hoặc REJECTED.
    throw new NotImplementedException('OffersService.decideOffer TODO');
  }

  resolveOffer(offerId: string, dto: OfferResolutionDto): never {
    // TODO: đúng assignment; ASSIGNED/RETRY/CANCELLED; chống mâu thuẫn và hồi sinh job.
    throw new NotImplementedException('OffersService.resolveOffer TODO');
  }
}
