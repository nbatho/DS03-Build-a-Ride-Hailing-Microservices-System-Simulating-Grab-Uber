import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import type { Quote, ZoneId } from '@app/contracts';

@Entity({ schema: 'pricing_schema', name: 'quotes' })
export class QuoteEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'passenger_id', type: 'uuid' })
  passengerId!: string;

  @Column({ name: 'pickup_lat', type: 'numeric', precision: 9, scale: 6 })
  pickupLat!: string;

  @Column({ name: 'pickup_lng', type: 'numeric', precision: 9, scale: 6 })
  pickupLng!: string;

  @Column({ name: 'pickup_zone_id', type: 'text' })
  pickupZoneId!: ZoneId;

  @Column({ name: 'dropoff_lat', type: 'numeric', precision: 9, scale: 6 })
  dropoffLat!: string;

  @Column({ name: 'dropoff_lng', type: 'numeric', precision: 9, scale: 6 })
  dropoffLng!: string;

  @Column({ name: 'dropoff_zone_id', type: 'text' })
  dropoffZoneId!: ZoneId;

  @Column({ name: 'distance_meters', type: 'integer' })
  distanceMeters!: number;

  @Column({ name: 'duration_seconds', type: 'integer' })
  durationSeconds!: number;

  @Column({ type: 'bigint' })
  amount!: string;

  @Column({ type: 'text' })
  currency!: 'VND';

  @Column({ name: 'rule_version', type: 'varchar', length: 40 })
  ruleVersion!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;
}

export function toQuote(entity: QuoteEntity): Quote {
  return {
    id: entity.id,
    passengerId: entity.passengerId,
    pickup: {
      lat: Number(entity.pickupLat),
      lng: Number(entity.pickupLng),
      zoneId: entity.pickupZoneId,
    },
    dropoff: {
      lat: Number(entity.dropoffLat),
      lng: Number(entity.dropoffLng),
      zoneId: entity.dropoffZoneId,
    },
    distanceMeters: entity.distanceMeters,
    durationSeconds: entity.durationSeconds,
    amount: entity.amount,
    currency: entity.currency,
    ruleVersion: entity.ruleVersion,
    expiresAt: entity.expiresAt.toISOString(),
  };
}
