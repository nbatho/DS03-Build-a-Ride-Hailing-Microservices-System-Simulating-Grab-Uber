import { Module } from '@nestjs/common';
import { AuthVerifierModule } from '@app/auth';
import { MessagingModule } from '@app/messaging';
import { RuntimeModule } from '@app/runtime';
import { PaymentDatabaseModule } from './database/database.module';
import { PaymentsModule } from './payments/payments.module';

@Module({
  imports: [
    RuntimeModule.forRoot('simulated-payment-service'),
    PaymentDatabaseModule,
    MessagingModule.forRoot(),
    AuthVerifierModule,
    PaymentsModule,
  ],
})
export class AppModule {}
