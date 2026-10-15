import { Injectable, NotImplementedException } from '@nestjs/common';

// TODO: Kết nối broker, dừng worker an toàn và giữ eventId khi gửi lại.
@Injectable()
export class MatchingOutboxPublisher {
  publishPendingEvents(): never {
    // TODO: claim lease rồi publish ngoài transaction; confirm+mandatory return; reclaim PUBLISHING hết lease.
    throw new NotImplementedException('MatchingOutboxPublisher.publishPendingEvents TODO');
  }
}
