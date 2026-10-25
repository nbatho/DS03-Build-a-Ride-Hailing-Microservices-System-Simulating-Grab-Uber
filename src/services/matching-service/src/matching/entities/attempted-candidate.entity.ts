import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ schema: 'matching_schema', name: 'attempted_candidates' })
export class AttemptedCandidateEntity {
  @PrimaryColumn({ name: 'job_id', type: 'uuid' })
  jobId!: string;

  @PrimaryColumn({ name: 'driver_id', type: 'uuid' })
  driverId!: string;

  @Column({ name: 'attempted_at', type: 'timestamptz' })
  attemptedAt!: Date;
}
