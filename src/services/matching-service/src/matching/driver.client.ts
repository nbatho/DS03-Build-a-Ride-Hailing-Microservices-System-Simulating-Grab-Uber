import { Injectable, NotImplementedException } from '@nestjs/common';

@Injectable()
export class DriverClient {
  getCandidates(zoneId: 'ZONE_A' | 'ZONE_B', limit: number): never {
    // TODO: HTTP thật; caller token; 2s/lần tối đa3, backoff+jitter; validate consumer contract.
    throw new NotImplementedException('DriverClient.getCandidates TODO');
  }
}
