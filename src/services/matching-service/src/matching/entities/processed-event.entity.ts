import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ schema: 'matching_schema', name: 'processed_events' })
export class ProcessedEventEntity {
  @PrimaryColumn({ name: 'consumer_name', type: 'text' })
  consumerName!: string;

  @PrimaryColumn({ name: 'event_id', type: 'uuid' })
  eventId!: string;

  @Column({ name: 'event_type', type: 'text' })
  eventType!: string;

  @Column({ name: 'aggregate_id', type: 'uuid' })
  aggregateId!: string;

  @Column({ name: 'aggregate_version', type: 'integer' })
  aggregateVersion!: number;

  @Column({ name: 'correlation_id', type: 'uuid' })
  correlationId!: string;

  @Column({ name: 'processed_at', type: 'timestamptz' })
  processedAt!: Date;
}
