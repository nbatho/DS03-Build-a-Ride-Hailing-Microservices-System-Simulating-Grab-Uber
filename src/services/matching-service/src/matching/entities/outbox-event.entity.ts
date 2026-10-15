// TODO: Ánh xạ matching_schema.outbox_events bằng ORM và đăng ký với kết nối DB.
// TODO: aggregateId=jobId; event envelope theo contract; lease token mới khi reclaim.
export class OutboxEventEntity {
  declare eventId: string;
  declare type: 'matching.offer.created' | 'matching.failed';
  declare aggregateId: string;
  declare aggregateVersion: number;
  declare schemaVersion: number;
  declare correlationId: string;
  declare causationId: string;
  declare envelopeJson: Record<string, unknown>;
  declare status: 'PENDING' | 'PUBLISHING' | 'PUBLISHED' | 'FAILED';
  declare attempts: number;
  declare nextRetryAt: Date;
  declare leaseToken: string | null;
  declare leaseUntil: Date | null;
  declare lastError: string | null;
  declare createdAt: Date;
  declare publishedAt: Date | null;
}
