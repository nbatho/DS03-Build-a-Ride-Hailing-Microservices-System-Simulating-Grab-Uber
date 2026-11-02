import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { InternalRoute } from '@app/runtime';
import type { Quote } from '@app/contracts';
import { PricingService } from './pricing.service';

@InternalRoute('TRIP')
@Controller('internal/v1/quotes')
export class PricingInternalController {
  constructor(private readonly service: PricingService) {}

  @Get(':quoteId')
  getQuoteForTrip(@Param('quoteId', new ParseUUIDPipe()) quoteId: string): Promise<Quote> {
    return this.service.getQuoteForTrip(quoteId);
  }
}
