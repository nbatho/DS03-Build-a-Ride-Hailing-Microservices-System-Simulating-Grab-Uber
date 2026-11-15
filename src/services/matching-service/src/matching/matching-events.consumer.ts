import { Injectable, type OnModuleInit } from '@nestjs/common';
import { EVENT_QUEUES } from '@app/contracts';
import { EventConsumer, NonRetryableEventError, type EventHandlers } from '@app/messaging';
import { ApiError } from '@app/runtime';
import { MatchingService } from './matching.service';

// Nhận trip.requested và trip.cancelled từ queue matching.events qua @app/messaging: kiểm tra cỡ, cấu trúc,
// retry 1s/5s/15s và DLQ dùng chung với các service khác. ACK sau khi transaction của handler đã commit.

/** Lỗi 4xx là dữ liệu sai, gửi lại cũng không đúng hơn: vào DLQ ngay. Lỗi khác (DB bận...) để thử lại. */
export function toEventError(error: unknown): unknown {
  if (error instanceof ApiError && error.getStatus() < 500) {
    const code = (error.getResponse() as { code?: string }).code ?? 'INVALID_EVENT';

    return new NonRetryableEventError(code, error.message);
  }

  return error;
}

async function rethrowAsEventError(work: Promise<void>): Promise<void> {
  try {
    await work;
  } catch (error) {
    throw toEventError(error);
  }
}

export function matchingEventHandlers(service: MatchingService): EventHandlers {
  return {
    'trip.requested': event => rethrowAsEventError(service.createJobFromRequested(event)),
    'trip.cancelled': event => rethrowAsEventError(service.cancelJobFromEvent(event)),
  };
}

@Injectable()
export class MatchingEventsConsumer implements OnModuleInit {
  constructor(
    private readonly consumer: EventConsumer,
    private readonly service: MatchingService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.consumer.subscribe(EVENT_QUEUES.MATCHING, matchingEventHandlers(this.service));
  }
}
