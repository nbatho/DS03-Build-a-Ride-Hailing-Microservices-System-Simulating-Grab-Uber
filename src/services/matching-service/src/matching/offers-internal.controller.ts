import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { CurrentCaller, InternalRoute, type ContextRequest } from '@app/runtime';
import type { InternalCaller } from '@app/shared-types';
import type { Offer } from '@app/contracts';
import { OffersService } from './offers.service';
import { OfferDecisionDto } from './dto/offer-decision.dto';
import { OfferResolutionDto } from './dto/offer-resolution.dto';

@InternalRoute('TRIP')
@Controller('internal/v1/offers')
export class OffersInternalController {
  constructor(private readonly service: OffersService) {}

  @Get(':offerId')
  getOffer(@Param('offerId', new ParseUUIDPipe()) offerId: string): Promise<Offer> {
    return this.service.getOffer(offerId);
  }

  @Post(':offerId/decisions')
  @HttpCode(200)
  decideOffer(
    @Param('offerId', new ParseUUIDPipe()) offerId: string,
    @Body() dto: OfferDecisionDto,
    @CurrentCaller() caller: InternalCaller,
    @Req() req: ContextRequest,
  ): Promise<Offer> {
    return this.service.decideOffer(offerId.toLowerCase(), dto, caller, req.correlationId);
  }

  @Post(':offerId/resolution')
  @HttpCode(200)
  resolveOffer(
    @Param('offerId', new ParseUUIDPipe()) offerId: string,
    @Body() dto: OfferResolutionDto,
    @CurrentCaller() caller: InternalCaller,
    @Req() req: ContextRequest,
  ): Promise<Offer> {
    return this.service.resolveOffer(offerId.toLowerCase(), dto, caller, req.correlationId);
  }
}
