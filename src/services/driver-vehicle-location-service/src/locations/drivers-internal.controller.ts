import { Controller, Get, Query } from '@nestjs/common';
import { InternalRoute } from '@app/runtime';
import type { Candidates } from '@app/contracts';
import { LocationsService } from './locations.service';
import { CandidatesQueryDto } from './dto/candidates-query.dto';

@InternalRoute('MATCHING')
@Controller('internal/v1/drivers')
export class DriversInternalController {
  constructor(private readonly service: LocationsService) {}

  @Get('candidates')
  findCandidates(@Query() query: CandidatesQueryDto): Promise<Candidates> {
    return this.service.findCandidates(query);
  }
}
