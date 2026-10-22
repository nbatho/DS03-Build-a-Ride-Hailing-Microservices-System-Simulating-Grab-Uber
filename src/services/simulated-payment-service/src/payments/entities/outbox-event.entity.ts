import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

export type OutboxStatus = 'PENDING' | 'PUBLISHING' | 'PUBLISHED' | 'FAILED';

// payment_schema.outbox_events theo cấu trúc chuẩn của @app/messaging: ghi bằng enqueueOutboxEvent,
// OutboxRelay đọc và đánh dấu PUBLISHED. aggregate_id = paymentId.
@Entity({ name: 'outbox_events', schema: 'payment_schema' })
export class OutboxEvent {
  @PrimaryColumn('uuid', { name: 'event_id' })
  eventId!: string;

  @Column('text')
  type!: 'payment.succeeded' | 'payment.failed';

  @Column('uuid', { name: 'aggregate_id' })
  aggregateId!: string;

  @Column('integer', { name: 'aggregate_version' })
  aggregateVersion!: number;

  @Column('integer', { name: 'schema_version', default: 1 })
  schemaVersion!: number;

  @Column('uuid', { name: 'correlation_id' })
  correlationId!: string;

  @Column('uuid', { name: 'causation_id' })
  causationId!: string;

  @Column('jsonb', { name: 'envelope_json' })
  envelopeJson!: Record<string, unknown>;

  @Column('text', { default: 'PENDING' })
  status!: OutboxStatus;

  @Column('integer', { default: 0 })
  attempts!: number;

  @Column('timestamptz', { name: 'next_retry_at' })
  nextRetryAt!: Date;

  @Column('uuid', { name: 'lease_token', nullable: true })
  leaseToken!: string | null;

  @Column('timestamptz', { name: 'lease_until', nullable: true })
  leaseUntil!: Date | null;

  @Column('text', { name: 'last_error', nullable: true })
  lastError!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column('timestamptz', { name: 'published_at', nullable: true })
  publishedAt!: Date | null;
}
