import { Injectable } from '@nestjs/common';
import type { Candidates, ZoneId } from '@app/contracts';
import { ApiError, InternalHttpClient } from '@app/runtime';
import { readCandidates } from './event-contracts';

@Injectable()
export class DriverClient {
  constructor(private readonly http: InternalHttpClient) {}

  async getCandidates(zoneId: ZoneId, limit: number, correlationId: string): Promise<Candidates> {
    const response = await this.http.request('DRIVER', {
      method: 'GET',
      path: '/internal/v1/drivers/candidates?zoneId=' + zoneId + '&limit=' + limit,
      correlationId,
      retry: true,
    });

    if (response.status !== 200) {
      throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE', 'Driver candidates are unavailable');
    }

    return readCandidates(response.body);
  }
}
