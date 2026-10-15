import { Injectable, NotImplementedException } from '@nestjs/common';
import { CreateQuoteDto } from './dto/create-quote.dto';


@Injectable()
export class PricingService {
  createQuote(passengerId: string, dto: CreateQuoteDto, idempotencyKey: string): never {
    // TODO: actor verified; CAR_V1 BigInt; key+snapshot+response atomic; TTL300s.
    throw new NotImplementedException('PricingService.createQuote TODO');
  }

  getMyQuote(passengerId: string, quoteId: string): never {
    // TODO: verify owner; hết hạn vẫn đọc HTTP200; không tính lại theo rule mới.
    throw new NotImplementedException('PricingService.getMyQuote TODO');
  }

  getQuoteForTrip(quoteId: string): never {
    // TODO: trả owner/expiry/points/units/amount/ruleVersion; chỉ caller Trip được đọc.
    throw new NotImplementedException('PricingService.getQuoteForTrip TODO');
  }
}
