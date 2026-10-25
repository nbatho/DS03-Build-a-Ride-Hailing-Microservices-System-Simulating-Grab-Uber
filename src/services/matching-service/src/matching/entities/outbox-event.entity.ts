import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ schema: 'matching_schema', name: 'outbox_events' })
export class OutboxEventEntity {
  @PrimaryColumn({ name: 'event_id', type: 'uuid' })
  eventId!: string;

  @Column({ name: 'type', type: 'text' })
  type!: string;

  @Column({ name: 'aggregate_id', type: 'uuid' })
  aggregateId!: string;

  @Column({ name: 'aggregate_version', type: 'integer' })
  aggregateVersion!: number;

  @Column({ name: 'schema_version', type: 'integer' })
  schemaVersion!: number;

  @Column({ name: 'correlation_id', type: 'uuid' })
  correlationId!: string;

  @Column({ name: 'causation_id', type: 'uuid' })
  causationId!: string;

  @Column({ name: 'envelope_json', type: 'jsonb' })
  envelopeJson!: Record<string, unknown>;

  @Column({ name: 'status', type: 'text' })
  status!: string;

  @Column({ name: 'attempts', type: 'integer' })
  attempts!: number;

  @Column({ name: 'next_retry_at', type: 'timestamptz' })
  nextRetryAt!: Date;

  @Column({ name: 'lease_token', type: 'uuid', nullable: true })
  leaseToken!: string | null;

  @Column({ name: 'lease_until', type: 'timestamptz', nullable: true })
  leaseUntil!: Date | null;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;
}
