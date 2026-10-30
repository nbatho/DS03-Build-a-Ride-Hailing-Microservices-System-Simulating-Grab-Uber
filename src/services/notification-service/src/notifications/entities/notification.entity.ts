import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

export enum NotificationType {
  OFFER = 'OFFER',
  TRIP_STATUS = 'TRIP_STATUS',
  PAYMENT_STATUS = 'PAYMENT_STATUS',
}

// Field riêng từng loại (offer/pickup/dropoff/amount/currency, tripStatus, paymentStatus; Phụ lục B) lưu trong payload.
// read = read_at IS NOT NULL; actionable tính lúc đọc từ trip_projection và hạn lời mời.
// Không trùng theo (recipient_id, source_event_id, type).
@Entity({ name: 'notifications', schema: 'notification_schema' })
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'recipient_id' })
  recipientId!: string;

  @Column('uuid', { name: 'source_event_id' })
  sourceEventId!: string;

  @Column('uuid', { name: 'trip_id' })
  tripId!: string;

  @Column('text')
  type!: NotificationType;

  @Column('varchar', { length: 200 })
  title!: string;

  @Column('jsonb')
  payload!: Record<string, unknown>;

  @Column('timestamptz', { name: 'read_at', nullable: true })
  readAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
