import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'operation_retries', schema: 'trip_schema' })
export class OperationRetry {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'operation_id' })
  operationId!: string;

  @Column('uuid', { name: 'command_id' })
  commandId!: string;

  @Column('text')
  caller!: string;

  @Column('text')
  reason!: string;

  @Column('text', { name: 'from_step' })
  fromStep!: string;

  @Column('text', { name: 'previous_error_code', nullable: true })
  previousErrorCode!: string | null;

  @Column('uuid', { name: 'correlation_id' })
  correlationId!: string;
}
