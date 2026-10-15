import { Injectable, NotImplementedException } from '@nestjs/common';
import { LocationDto } from './dto/location.dto';
import { CandidatesQueryDto } from './dto/candidates-query.dto';

@Injectable()
export class LocationsService {
  updateLocation(driverId: string, dto: LocationDto): never {
    // TODO: sequence CAS; cùng seq/payload replay; seq cũ/khác payload conflict; receivedAt từ server.
    throw new NotImplementedException('LocationsService.updateLocation TODO');
  }

  findCandidates(query: CandidatesQueryDto): never {
    // TODO: zone/online/xe/GPS<=60s/không active reservation; sort driverId; đây chỉ là snapshot.
    throw new NotImplementedException('LocationsService.findCandidates TODO');
  }
}
