import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

// notification_schema.processed_events: bỏ trùng theo (consumer_name, event_id); ghi bằng processEventOnce của @app/messaging.
@Entity({ name: 'processed_events', schema: 'notification_schema' })
export class ProcessedEvent {
  @PrimaryColumn('text', { name: 'consumer_name' })
  consumerName!: string;

  @PrimaryColumn('uuid', { name: 'event_id' })
  eventId!: string;

  @Column('text', { name: 'event_type' })
  eventType!: string;

  @Column('uuid', { name: 'aggregate_id' })
  aggregateId!: string;

  @Column('integer', { name: 'aggregate_version' })
  aggregateVersion!: number;

  @Column('uuid', { name: 'correlation_id' })
  correlationId!: string;

  @CreateDateColumn({ name: 'processed_at', type: 'timestamptz' })
  processedAt!: Date;
}
