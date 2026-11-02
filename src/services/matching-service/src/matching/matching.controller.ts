import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { CurrentCaller, InternalRoute, type ContextRequest } from '@app/runtime';
import type { InternalCaller } from '@app/shared-types';
import type { MatchingJob } from '@app/contracts';
import { MatchingService } from './matching.service';
import { CancelMatchingJobDto } from './dto/cancel-matching-job.dto';

@InternalRoute('TRIP')
@Controller('internal/v1/matching/jobs')
export class MatchingController {
  constructor(private readonly service: MatchingService) {}

  @Get(':tripId')
  getJobByTripId(@Param('tripId', new ParseUUIDPipe()) tripId: string): Promise<MatchingJob> {
    return this.service.getJobByTripId(tripId);
  }

  @Post(':tripId/cancel')
  @HttpCode(200)
  cancelJob(
    @Param('tripId', new ParseUUIDPipe()) tripId: string,
    @Body() dto: CancelMatchingJobDto,
    @CurrentCaller() caller: InternalCaller,
    @Req() req: ContextRequest,
  ): Promise<MatchingJob> {
    return this.service.cancelJob(tripId.toLowerCase(), dto, caller, req.correlationId);
  }
}
