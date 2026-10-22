import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { CurrentUser, Roles } from '@app/auth';
import type { Actor, Payment } from '@app/contracts';
import { ApiError } from '@app/runtime';
import { PaymentByTripQueryDto } from './dto/payment-query.dto';
import { PaymentsService } from './payments.service';

const paymentId = new ParseUUIDPipe({
  exceptionFactory: () => new ApiError(400, 'VALIDATION_ERROR', 'paymentId must be a UUID'),
});

// API-33, API-34: khách chỉ xem thanh toán của mình; không có API để client tự thu tiền.
@Controller('payments')
@Roles('PASSENGER')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  getByTrip(@CurrentUser() actor: Actor, @Query() query: PaymentByTripQueryDto): Promise<Payment> {
    return this.payments.getByTripForPassenger(actor.userId, query.tripId);
  }

  @Get(':paymentId')
  getOne(@CurrentUser() actor: Actor, @Param('paymentId', paymentId) id: string): Promise<Payment> {
    return this.payments.getForPassenger(actor.userId, id);
  }
}
