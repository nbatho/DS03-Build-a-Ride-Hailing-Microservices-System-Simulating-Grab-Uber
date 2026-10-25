import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { Location, ZoneId } from '@app/contracts';

export function toSequence(value: string | number): number {
  const sequence = Number(value);

  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error('Location sequence is outside the supported integer range');
  }

  return sequence;
}

@Entity({ schema: 'driver_schema', name: 'latest_locations' })
export class LatestLocationEntity {
  @PrimaryColumn({ name: 'driver_id', type: 'uuid' })
  driverId!: string;

  @Column({ type: 'numeric', precision: 9, scale: 6 })
  lat!: string;

  @Column({ type: 'numeric', precision: 9, scale: 6 })
  lng!: string;

  @Column({ name: 'zone_id', type: 'text' })
  zoneId!: ZoneId;

  @Column({ type: 'bigint', transformer: { to: (value: number) => value, from: toSequence } })
  sequence!: number;

  @Column({ name: 'recorded_at', type: 'timestamptz' })
  recordedAt!: Date;

  @Column({ name: 'received_at', type: 'timestamptz' })
  receivedAt!: Date;
}

export function toLocation(entity: LatestLocationEntity): Location {
  return {
    driverId: entity.driverId,
    position: { lat: Number(entity.lat), lng: Number(entity.lng), zoneId: entity.zoneId },
    sequence: entity.sequence,
    recordedAt: entity.recordedAt.toISOString(),
    receivedAt: entity.receivedAt.toISOString(),
  };
}
