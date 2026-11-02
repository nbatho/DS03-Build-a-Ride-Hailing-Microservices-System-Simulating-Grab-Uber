import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

// Đọc/ghi bởi withIdempotencyKey trong @app/runtime, cùng transaction với báo giá.
@Entity({ schema: 'pricing_schema', name: 'idempotency_keys' })
export class IdempotencyKeyEntity {
  @PrimaryColumn({ name: 'actor_id', type: 'uuid' })
  actorId!: string;

  @PrimaryColumn({ type: 'varchar', length: 10 })
  method!: string;

  @PrimaryColumn({ type: 'varchar', length: 255 })
  path!: string;

  @PrimaryColumn('uuid')
  key!: string;

  @Column({ name: 'request_hash', type: 'text' })
  requestHash!: string;

  @Column({ type: 'text' })
  status!: 'IN_PROGRESS' | 'COMPLETED';

  @Column({ name: 'response_status', type: 'smallint', nullable: true })
  responseStatus!: number | null;

  @Column({ name: 'response_body', type: 'jsonb', nullable: true })
  responseBody!: unknown;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;
}
