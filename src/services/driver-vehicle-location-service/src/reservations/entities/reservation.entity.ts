import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import type { Reservation, ReservationStatus, ReleaseReason } from '@app/contracts';

@Entity({ schema: 'driver_schema', name: 'reservations' })
export class ReservationEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'trip_id', type: 'uuid' })
  tripId!: string;

  @Column({ name: 'driver_id', type: 'uuid' })
  driverId!: string;

  @Column({ name: 'offer_id', type: 'uuid', nullable: true })
  offerId!: string | null;

  @Column({ type: 'text' })
  status!: ReservationStatus;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  @Column({ type: 'integer', default: 1 })
  version!: number;

  @Column({ name: 'release_reason', type: 'text', nullable: true })
  releaseReason!: ReleaseReason | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

export function toReservation(entity: ReservationEntity): Reservation {
  return {
    id: entity.id,
    tripId: entity.tripId,
    driverId: entity.driverId,
    ...(entity.offerId ? { offerId: entity.offerId } : {}),
    status: entity.status,
    ...(entity.status === 'HELD' && entity.expiresAt
      ? { expiresAt: entity.expiresAt.toISOString() }
      : {}),
    version: entity.version,
  };
}
