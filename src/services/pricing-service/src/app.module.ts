import { Module } from '@nestjs/common';
import { RuntimeModule } from '@app/runtime';
import { AuthVerifierModule } from '@app/auth';
import { PricingDatabaseModule } from './database/database.module';
import { PricingModule } from './pricing/pricing.module';

@Module({
  imports: [
    RuntimeModule.forRoot('pricing-service'),
    AuthVerifierModule,
    PricingDatabaseModule,
    PricingModule,
  ],
})
export class AppModule {}
