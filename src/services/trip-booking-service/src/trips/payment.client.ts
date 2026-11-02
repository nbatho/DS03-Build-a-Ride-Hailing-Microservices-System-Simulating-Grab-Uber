import { Injectable } from '@nestjs/common';
import type { Payment } from '@app/contracts';
import { ApiError, InternalHttpClient } from '@app/runtime';
import { readPayment } from './upstream-contracts';

@Injectable()
export class PaymentClient {
  constructor(private readonly http: InternalHttpClient) {}

  async getPayment(paymentId: string, correlationId: string): Promise<Payment | null> {
    const response = await this.http.request('PAYMENT', {
      method: 'GET',
      path: '/internal/v1/payments/' + paymentId,
      correlationId,
      retry: true,
    });

    if (response.status === 404) {
      return null;
    }

    if (response.status !== 200) {
      throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE', 'Payment is unavailable');
    }

    return readPayment(response.body, paymentId);
  }
}
