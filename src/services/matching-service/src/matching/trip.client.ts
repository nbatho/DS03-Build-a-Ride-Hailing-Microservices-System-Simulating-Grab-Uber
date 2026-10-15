import { Injectable, NotImplementedException } from '@nestjs/common';

@Injectable()
export class TripClient {
  getTrip(tripId: string): never {
    // TODO: lookup authoritative phục vụ stale CLAIMED; service token/timeout; không đọc DB Trip.
    throw new NotImplementedException('TripClient.getTrip TODO');
  }
}
