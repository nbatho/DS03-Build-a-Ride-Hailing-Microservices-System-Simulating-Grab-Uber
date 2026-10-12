import { Module } from '@nestjs/common';
import { RuntimeModule } from '@app/runtime';
import { PaymentsModule } from './payments/payments.module';

@Module({
  imports: [RuntimeModule.forRoot('simulated-payment-service'), PaymentsModule],
})
export class AppModule {}
