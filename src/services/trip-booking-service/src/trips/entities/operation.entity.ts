import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn, type Relation } from 'typeorm';
import type { Operation as OperationDto, OperationStatus, OperationType } from '@app/contracts';
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

  @Column('text', { name: 'error_code', nullable: true })
  errorCode!: string | null;

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
