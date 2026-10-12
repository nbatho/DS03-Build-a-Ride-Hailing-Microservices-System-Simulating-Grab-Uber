import { Module } from '@nestjs/common';
import { RuntimeModule } from '@app/runtime';
import { PricingModule } from './pricing/pricing.module';

@Module({
  imports: [RuntimeModule.forRoot('pricing-service'), PricingModule],
})
export class AppModule {}
