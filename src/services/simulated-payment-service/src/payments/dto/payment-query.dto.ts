import { IsUUID } from 'class-validator';

/** GET /api/v1/payments?tripId= (API-34): tripId bắt buộc, không liệt kê thanh toán khác. */
export class PaymentByTripQueryDto {
  @IsUUID()
  tripId!: string;
}
