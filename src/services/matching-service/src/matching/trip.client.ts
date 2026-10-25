import { Injectable } from '@nestjs/common';
import { ApiError, InternalHttpClient } from '@app/runtime';
import { readTrip, type TripView } from './event-contracts';

@Injectable()
export class TripClient {
  constructor(private readonly http: InternalHttpClient) {}

  async getTrip(tripId: string, correlationId: string): Promise<TripView | null> {
    const response = await this.http.request('TRIP', {
      method: 'GET',
      path: '/internal/v1/trips/' + tripId,
      correlationId,
      retry: true,
    });

    if (response.status === 404) {
      return null;
    }

    if (response.status !== 200) {
      throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE', 'Trip state is unavailable');
    }

    return readTrip(response.body, tripId);
  }
}
