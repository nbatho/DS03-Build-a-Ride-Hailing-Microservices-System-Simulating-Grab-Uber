import { Injectable } from '@nestjs/common';
import type { Quote } from '@app/contracts';
import { ApiError, InternalHttpClient } from '@app/runtime';
import { readQuote } from './upstream-contracts';

@Injectable()
export class PricingClient {
  constructor(private readonly http: InternalHttpClient) {}

  async getQuote(quoteId: string, correlationId: string): Promise<Quote> {
    const response = await this.http.request('PRICING', {
      method: 'GET',
      path: '/internal/v1/quotes/' + quoteId,
      correlationId,
      retry: true,
    });

    if (response.status === 404) {
      throw new ApiError(404, 'QUOTE_NOT_FOUND', 'Quote not found');
    }

    if (response.status !== 200) {
      throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE', 'Pricing is unavailable');
    }

    return readQuote(response.body, quoteId);
  }
}
