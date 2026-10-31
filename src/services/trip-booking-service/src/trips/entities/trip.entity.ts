import { Column, Entity, OneToOne, PrimaryColumn, type Relation } from 'typeorm';
import type { Point, Trip as TripDto, TripPaymentStatus, TripStatus } from '@app/contracts';
import { FareSnapshot } from './fare-snapshot.entity';

@Entity({ name: 'trips', schema: 'trip_schema' })
export class Trip {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'passenger_id' })
  passengerId!: string;

  @Column('uuid', { name: 'driver_id', nullable: true })
  driverId!: string | null;

  @Column('uuid', { name: 'quote_id' })
  quoteId!: string;

  @Column('uuid', { name: 'assignment_id', nullable: true })
  assignmentId!: string | null;

  @Column('jsonb')
  pickup!: Point;

  @Column('jsonb')
  dropoff!: Point;

  @Column('text')
  status!: TripStatus;

  @Column('uuid', { name: 'payment_id', nullable: true })
  paymentId!: string | null;

  @Column('text', { name: 'payment_status' })
  paymentStatus!: TripPaymentStatus;

  @Column('smallint', { name: 'payment_attempt_no' })
  paymentAttemptNo!: number;

  @Column('integer', { name: 'payment_version' })
  paymentVersion!: number;

  @Column('integer')
  version!: number;

  @Column('timestamptz', { name: 'created_at' })
  createdAt!: Date;

  @Column('timestamptz', { name: 'updated_at' })
  updatedAt!: Date;

  @OneToOne(() => FareSnapshot, fare => fare.trip)
  fare!: Relation<FareSnapshot>;
}

export function toTrip(trip: Trip): TripDto {
  return {
    id: trip.id,
    passengerId: trip.passengerId,
    ...(trip.driverId ? { driverId: trip.driverId } : {}),
    quoteId: trip.quoteId,
    ...(trip.assignmentId ? { assignmentId: trip.assignmentId } : {}),
    pickup: trip.pickup,
    dropoff: trip.dropoff,
    amount: trip.fare.amount,
    currency: trip.fare.currency,
    status: trip.status,
    paymentStatus: trip.paymentStatus,
    ...(trip.paymentId ? { paymentId: trip.paymentId } : {}),
    version: trip.version,
    createdAt: trip.createdAt.toISOString(),
    updatedAt: trip.updatedAt.toISOString(),
  };
}

export function toTripProgress(trip: Trip): TripDto {
  return toTrip({ ...trip, driverId: null, assignmentId: null, paymentId: null });
}
