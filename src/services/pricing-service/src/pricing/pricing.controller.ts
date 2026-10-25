import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { CurrentUser, Roles } from '@app/auth';
import type { Actor, Quote } from '@app/contracts';
import { IdempotencyKey } from '@app/runtime';
import { PricingService } from './pricing.service';
import { CreateQuoteDto } from './dto/create-quote.dto';

@Controller('quotes')
@Roles('PASSENGER')
export class PricingController {
  constructor(private readonly service: PricingService) {}

  @Post()
  createQuote(
    @CurrentUser() actor: Actor,
    @Body() dto: CreateQuoteDto,
    @IdempotencyKey() idempotencyKey: string,
  ): Promise<Quote> {
    return this.service.createQuote(actor.userId, dto, idempotencyKey);
  }

  @Get(':quoteId')
  getMyQuote(
    @CurrentUser() actor: Actor,
    @Param('quoteId', new ParseUUIDPipe()) quoteId: string,
  ): Promise<Quote> {
    return this.service.getMyQuote(actor.userId, quoteId);
  }
}
