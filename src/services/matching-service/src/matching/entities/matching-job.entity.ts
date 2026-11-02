import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { MatchingJobStatus } from '@app/contracts';
import type { TripRequestedEvent } from '../event-contracts';

@Entity({ schema: 'matching_schema', name: 'matching_jobs' })
export class MatchingJobEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' })
  id!: string;

  @Column({ name: 'trip_id', type: 'uuid' })
  tripId!: string;

  @Column({ name: 'status', type: 'text' })
  status!: MatchingJobStatus;

  @Column({ name: 'version', type: 'integer' })
  version!: number;

  @Column({ name: 'latest_trip_version', type: 'integer' })
  latestTripVersion!: number;

  @Column({ name: 'trip_snapshot', type: 'jsonb', nullable: true })
  tripSnapshot!: TripRequestedEvent | null;

  @Column({ name: 'search_deadline', type: 'timestamptz', nullable: true })
  searchDeadline!: Date | null;

  @Column({ name: 'current_offer_id', type: 'uuid', nullable: true })
  currentOfferId!: string | null;

  @Column({ name: 'next_retry_at', type: 'timestamptz' })
  nextRetryAt!: Date;

  @Column({ name: 'lease_token', type: 'uuid', nullable: true })
  leaseToken!: string | null;

  @Column({ name: 'lease_until', type: 'timestamptz', nullable: true })
  leaseUntil!: Date | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
