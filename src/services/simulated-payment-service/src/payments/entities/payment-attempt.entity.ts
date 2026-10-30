import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Payment } from './payment.entity';

export enum PaymentAttemptResult {
  SUCCESS = 'SUCCESS',
  TEMPORARY_FAILURE = 'TEMPORARY_FAILURE',
  FINAL_FAILURE = 'FINAL_FAILURE',
}

// Lịch sử từng lần thử, chỉ thêm (app không có quyền UPDATE/DELETE). Khóa (payment_id, attempt_no).
@Entity({ name: 'payment_attempts', schema: 'payment_schema' })
export class PaymentAttempt {
  @PrimaryColumn('uuid', { name: 'payment_id' })
  paymentId!: string;

  @PrimaryColumn('smallint', { name: 'attempt_no' })
  attemptNo!: number;

  @Column('text')
  result!: PaymentAttemptResult;

  @Column('boolean')
  retryable!: boolean;

  @Column('text', { nullable: true })
  reason!: string | null;

  @Column('uuid', { name: 'source_event_id' })
  sourceEventId!: string;

  @Column('uuid', { name: 'correlation_id' })
  correlationId!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @ManyToOne(() => Payment, payment => payment.attempts)
  @JoinColumn({ name: 'payment_id' })
  payment?: Payment;
}
