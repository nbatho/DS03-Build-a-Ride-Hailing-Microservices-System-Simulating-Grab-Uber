import { Module } from '@nestjs/common';
import { PricingController } from './pricing.controller';
import { PricingInternalController } from './pricing-internal.controller';
import { PricingService } from './pricing.service';
import { FareCalculator } from './fare-calculator';

// TODO: DB pricing_schema, JWT/internal guard, immutable snapshot privileges, readiness và migration runner.

@Module({
  controllers: [PricingController, PricingInternalController],
  providers: [PricingService, FareCalculator],
})
export class PricingModule {}
