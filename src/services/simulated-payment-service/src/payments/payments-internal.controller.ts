import { Controller, Get, Param } from '@nestjs/common';
import type { Payment } from '@app/contracts';
import { InternalRoute, uuidParam } from '@app/runtime';
import { PaymentsService } from './payments.service';

// API-35: Trip đối soát thanh toán; không qua Gateway, kiểm tra X-Service-Token (SVC_TOKEN_TRIP_PAYMENT).
@InternalRoute('TRIP')
@Controller('internal/v1/payments')
export class PaymentsInternalController {
  constructor(private readonly payments: PaymentsService) {}

  @Get(':paymentId')
  getOne(@Param('paymentId', uuidParam('paymentId')) id: string): Promise<Payment> {
    return this.payments.getForTrip(id);
  }
}
