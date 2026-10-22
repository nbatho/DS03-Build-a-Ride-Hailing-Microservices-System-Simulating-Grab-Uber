import { Column, CreateDateColumn, Entity, OneToMany, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { PaymentAttempt } from './payment-attempt.entity';

export enum PaymentStatus {
  PENDING = 'PENDING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
}

// Một khoản thanh toán cho mỗi chuyến (unique trip_id); id do Trip cấp, cố định qua mọi lần thử.
@Entity({ name: 'payments', schema: 'payment_schema' })
export class Payment {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'trip_id', unique: true })
  tripId!: string;

  @Column('uuid', { name: 'passenger_id' })
  passengerId!: string;

  // PostgreSQL bigint đọc ra dạng chuỗi để không mất chính xác; khớp MoneyAmount của contract.
  @Column('bigint')
  amount!: string;

  @Column('text', { default: 'VND' })
  currency!: 'VND';

  @Column('text', { default: PaymentStatus.PENDING })
  status!: PaymentStatus;

  @Column('integer', { default: 1 })
  version!: number;

  @Column('smallint', { name: 'attempt_no', default: 0 })
  attemptNo!: number;

  @Column('boolean', { default: true })
  retryable!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @OneToMany(() => PaymentAttempt, attempt => attempt.payment)
  attempts?: PaymentAttempt[];
}
