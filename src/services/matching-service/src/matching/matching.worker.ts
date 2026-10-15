import { Injectable, NotImplementedException } from '@nestjs/common';

// TODO: Bổ sung lease, lịch chạy định kỳ và dừng worker an toàn.
@Injectable()
export class MatchingWorker {
  searchNextCandidates(): never {
    // TODO: HTTP ngoài transaction; recheck lease/version/status; max5, deadline60s; attempt+offer+outbox atomic.
    throw new NotImplementedException('MatchingWorker.searchNextCandidates TODO');
  }

  expireOpenOffers(): never {
    // TODO: chỉ expire OPEN15s; khóa job trước offer; chọn tiếp nếu còn budget.
    throw new NotImplementedException('MatchingWorker.expireOpenOffers TODO');
  }

  reconcileClaimedOffers(): never {
    // TODO: lookup Trip ngoài transaction; verify assignment/version/lease; ASSIGNING thì chờ, không tự release.
    throw new NotImplementedException('MatchingWorker.reconcileClaimedOffers TODO');
  }
}
