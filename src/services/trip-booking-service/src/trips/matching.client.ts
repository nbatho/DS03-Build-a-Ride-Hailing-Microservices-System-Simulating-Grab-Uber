import { Injectable } from '@nestjs/common';
import type { MatchingJob } from '@app/contracts';
import { ApiError, InternalHttpClient } from '@app/runtime';
import { readJob } from './upstream-contracts';

@Injectable()
export class MatchingClient {
  constructor(private readonly http: InternalHttpClient) {}

  async getJob(tripId: string, correlationId: string): Promise<MatchingJob | null> {
    const response = await this.http.request('MATCHING', {
      method: 'GET',
      path: '/internal/v1/matching/jobs/' + tripId,
      correlationId,
      retry: true,
    });

    if (response.status === 404) {
      return null;
    }

    if (response.status !== 200) {
      throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE', 'Matching is unavailable');
    }

    return readJob(response.body, tripId);
  }
}
