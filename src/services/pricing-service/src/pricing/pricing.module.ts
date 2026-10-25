import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PricingController } from './pricing.controller';
import { PricingInternalController } from './pricing-internal.controller';
import { PricingService } from './pricing.service';
import { FareCalculator } from './fare-calculator';
import { FareRuleEntity } from './entities/fare-rule.entity';
import { QuoteEntity } from './entities/quote.entity';
import { IdempotencyKeyEntity } from './entities/idempotency-key.entity';

@Module({
  imports: [TypeOrmModule.forFeature([FareRuleEntity, QuoteEntity, IdempotencyKeyEntity])],
  controllers: [PricingController, PricingInternalController],
  providers: [PricingService, FareCalculator],
})
export class PricingModule {}
