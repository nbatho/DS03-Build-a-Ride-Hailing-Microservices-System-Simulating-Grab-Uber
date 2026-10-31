import { Column, Entity, PrimaryColumn } from 'typeorm';

export type SagaStepStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED';

@Entity({ name: 'saga_steps', schema: 'trip_schema' })
export class SagaStep {
  @PrimaryColumn('uuid', { name: 'operation_id' })
  operationId!: string;

  @PrimaryColumn('text')
  step!: string;

  @Column('uuid', { name: 'command_id' })
  commandId!: string;

  @Column('text')
  status!: SagaStepStatus;

  @Column('timestamptz', { name: 'updated_at' })
  updatedAt!: Date;
}
