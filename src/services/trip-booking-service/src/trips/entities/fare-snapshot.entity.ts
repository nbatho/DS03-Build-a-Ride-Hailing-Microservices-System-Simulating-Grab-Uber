import { Column, Entity, JoinColumn, OneToOne, PrimaryColumn, type Relation } from 'typeorm';
import type { Currency } from '@app/contracts';
import { Trip } from './trip.entity';

@Entity({ name: 'fare_snapshots', schema: 'trip_schema' })
export class FareSnapshot {
  @PrimaryColumn('uuid', { name: 'trip_id' })
  tripId!: string;

  @Column('bigint')
  amount!: string;

  @Column('text')
  currency!: Currency;

  @Column('text', { name: 'rule_version' })
  ruleVersion!: string;

  @Column('integer', { name: 'distance_meters' })
  distanceMeters!: number;

  @Column('integer', { name: 'duration_seconds' })
  durationSeconds!: number;

  @OneToOne(() => Trip, trip => trip.fare)
  @JoinColumn({ name: 'trip_id' })
  trip?: Relation<Trip>;
}
