import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { TripStatus } from '@app/contracts';

@Entity({ name: 'state_history', schema: 'trip_schema' })
export class StateHistory {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'trip_id' })
  tripId!: string;

  @Column('text', { name: 'from_status', nullable: true })
  fromStatus!: TripStatus | null;

  @Column('text', { name: 'to_status' })
  toStatus!: TripStatus;

  @Column('uuid', { name: 'actor_id', nullable: true })
  actorId!: string | null;

  @Column('uuid', { name: 'command_id' })
  commandId!: string;

  @Column('uuid', { name: 'correlation_id' })
  correlationId!: string;

  @Column('timestamptz', { name: 'occurred_at' })
  occurredAt!: Date;
}
