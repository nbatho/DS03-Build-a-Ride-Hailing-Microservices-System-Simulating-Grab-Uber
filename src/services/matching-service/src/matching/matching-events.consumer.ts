import { Injectable, NotImplementedException } from '@nestjs/common';

// TODO: Kết nối RabbitMQ để nhận sự kiện qua primitive chung.
@Injectable()
export class MatchingEventsConsumer {
  handleTripRequested(envelope: unknown): never {
    // TODO: gọi MatchingService sau validate; ACK sau commit; rollback dedup khi lỗi; retry/DLQ theo C.
    throw new NotImplementedException('MatchingEventsConsumer.handleTripRequested TODO');
  }

  handleTripCancelled(envelope: unknown): never {
    // TODO: gọi MatchingService với dedup/version fence; cancellation đến trước vẫn tạo tombstone.
    throw new NotImplementedException('MatchingEventsConsumer.handleTripCancelled TODO');
  }
}
