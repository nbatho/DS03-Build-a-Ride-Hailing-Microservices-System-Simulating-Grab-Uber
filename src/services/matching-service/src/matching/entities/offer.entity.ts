import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { OfferStatus, OfferDecisionAction, OfferResolutionResult } from '@app/contracts';

@Entity({ schema: 'matching_schema', name: 'offers' })
export class OfferEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' })
  id!: string;

  @Column({ name: 'job_id', type: 'uuid' })
  jobId!: string;

  @Column({ name: 'trip_id', type: 'uuid' })
  tripId!: string;

  @Column({ name: 'driver_id', type: 'uuid' })
  driverId!: string;

  @Column({ name: 'status', type: 'text' })
  status!: OfferStatus;

  @Column({ name: 'assignment_id', type: 'uuid', nullable: true })
  assignmentId!: string | null;

  @Column({ name: 'decision_action', type: 'text', nullable: true })
  decisionAction!: OfferDecisionAction | null;

  @Column({ name: 'resolution_result', type: 'text', nullable: true })
  resolutionResult!: OfferResolutionResult | null;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'version', type: 'integer' })
  version!: number;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
