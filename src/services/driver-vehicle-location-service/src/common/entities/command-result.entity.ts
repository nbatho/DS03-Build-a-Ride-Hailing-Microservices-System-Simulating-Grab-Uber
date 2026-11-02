import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity({ schema: 'driver_schema', name: 'command_results' })
export class CommandResultEntity {
  @PrimaryColumn({ name: 'caller_service', type: 'text' })
  callerService!: string;

  @PrimaryColumn({ name: 'command_type', type: 'text' })
  commandType!: string;

  @PrimaryColumn({ name: 'command_id', type: 'uuid' })
  commandId!: string;

  @Column({ name: 'resource_id', type: 'uuid' })
  resourceId!: string;

  @Column({ name: 'request_hash', type: 'text' })
  requestHash!: string;

  @Column({ type: 'text' })
  status!: 'IN_PROGRESS' | 'COMPLETED';

  @Column({ name: 'response_status', type: 'smallint', nullable: true })
  responseStatus!: number | null;

  @Column({ name: 'response_body', type: 'jsonb', nullable: true })
  responseBody!: unknown;

  @Column({ name: 'correlation_id', type: 'uuid' })
  correlationId!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
