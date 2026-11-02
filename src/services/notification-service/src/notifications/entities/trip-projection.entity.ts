import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

// Bản sao trạng thái chuyến để xử lý sự kiện sai thứ tự (BA mục 8.3).
// trip_version và payment_version là hai dãy riêng, không so với nhau.
@Entity({ name: 'trip_projection', schema: 'notification_schema' })
export class TripProjection {
  @PrimaryColumn('uuid', { name: 'trip_id' })
  tripId!: string;

  @Column('integer', { name: 'trip_version', default: 0 })
  tripVersion!: number;

  @Column('text', { name: 'trip_status', nullable: true })
  tripStatus!: string | null;

  @Column('text', { name: 'terminal_state', nullable: true })
  terminalState!: 'COMPLETED' | 'CANCELLED' | 'NO_DRIVER' | null;

  @Column('uuid', { name: 'terminal_event_id', nullable: true })
  terminalEventId!: string | null;

  @Column('uuid', { name: 'known_driver_ids', array: true, default: () => "'{}'" })
  knownDriverIds!: string[];

  @Column('uuid', { name: 'passenger_id', nullable: true })
  passengerId!: string | null;

  @Column('uuid', { name: 'payment_id', nullable: true })
  paymentId!: string | null;

  @Column('integer', { name: 'payment_version', default: 0 })
  paymentVersion!: number;

  @Column('text', { name: 'payment_status', nullable: true })
  paymentStatus!: 'NOT_REQUESTED' | 'PENDING' | 'SUCCEEDED' | 'FAILED' | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
