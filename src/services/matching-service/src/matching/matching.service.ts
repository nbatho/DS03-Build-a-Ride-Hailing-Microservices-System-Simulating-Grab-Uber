import { Injectable, NotImplementedException } from '@nestjs/common';
import { CancelMatchingJobDto } from './dto/cancel-matching-job.dto';


@Injectable()
export class MatchingService {
  getJobByTripId(tripId: string): never {
    // TODO: đọc job/version/currentOfferId theo tripId.
    throw new NotImplementedException('MatchingService.getJobByTripId TODO');
  }

  cancelJob(tripId: string, dto: CancelMatchingJobDto): never {
    // TODO: command replay; latestTripVersion không lùi; tạo CANCELLED tombstone trước requested.
    throw new NotImplementedException('MatchingService.cancelJob TODO');
  }

  createJobFromRequested(envelope: unknown): never {
    // TODO: validate trip.requested; processed event + job cùng transaction; không mở lại tombstone.
    throw new NotImplementedException('MatchingService.createJobFromRequested TODO');
  }

  cancelJobFromEvent(envelope: unknown): never {
    // TODO: validate trip.cancelled; dedup/fence; giữ assignment để Trip cleanup.
    throw new NotImplementedException('MatchingService.cancelJobFromEvent TODO');
  }

  failSearch(jobId: string, reason: 'NO_CANDIDATE' | 'SEARCH_TIMEOUT'): never {
    // TODO: kiểm tra job/version; FAILED + matching.failed outbox cùng transaction; Trip quyết định NO_DRIVER.
    throw new NotImplementedException('MatchingService.failSearch TODO');
  }
}
