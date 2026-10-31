import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn, type Relation } from 'typeorm';
import type {
  Operation as OperationDto,
  OperationStatus,
  OperationType,
  TripCancelReason,
} from '@app/contracts';
import { Trip } from './trip.entity';

@Entity({ name: 'operations', schema: 'trip_schema' })
export class Operation {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'trip_id' })
  tripId!: string;

  @Column('uuid', { name: 'actor_id' })
  actorId!: string;

  @Column('text')
  type!: OperationType;

  @Column('text')
  status!: OperationStatus;

  @Column('uuid', { name: 'assignment_id', nullable: true })
  assignmentId!: string | null;

  @Column('uuid', { name: 'offer_id', nullable: true })
  offerId!: string | null;

  @Column('uuid', { name: 'driver_id', nullable: true })
  driverId!: string | null;

  @Column('text', { name: 'current_step' })
  currentStep!: string;

  @Column('integer', { name: 'attempt_count' })
  attemptCount!: number;

  @Column('timestamptz', { name: 'next_retry_at' })
  nextRetryAt!: Date;

  @Column('uuid', { name: 'lease_token', nullable: true })
  leaseToken!: string | null;

  @Column('timestamptz', { name: 'lease_until', nullable: true })
  leaseUntil!: Date | null;

  @Column('text', { name: 'error_code', nullable: true })
  errorCode!: string | null;

  @Column('text', { nullable: true })
  reason!: TripCancelReason | null;

  @Column('uuid', { name: 'correlation_id' })
  correlationId!: string;

  @Column('timestamptz', { name: 'created_at' })
  createdAt!: Date;

  @Column('timestamptz', { name: 'updated_at' })
  updatedAt!: Date;

  @ManyToOne(() => Trip)
  @JoinColumn({ name: 'trip_id' })
  trip!: Relation<Trip>;
}

export function toOperation(operation: Operation): OperationDto {
  return {
    id: operation.id,
    tripId: operation.tripId,
    type: operation.type,
    status: operation.status,
    tripStatus: operation.trip.status,
    ...(operation.assignmentId ? { assignmentId: operation.assignmentId } : {}),
    ...(operation.errorCode ? { errorCode: operation.errorCode } : {}),
    updatedAt: operation.updatedAt.toISOString(),
  };
}
