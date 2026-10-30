import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import type { TripStatus } from '@app/contracts';
import { StateHistory } from './entities/state-history.entity';
import { Trip } from './entities/trip.entity';

export interface TripTransition {
  tripId: string;
  from: TripStatus[];
  to: TripStatus;
  actorId: string | null;
  commandId: string;
  correlationId: string;
}

export interface TransitionedTrip {
  passengerId: string;
  version: number;
}

export async function transitionTrip(
  manager: EntityManager,
  input: TripTransition,
): Promise<TransitionedTrip | null> {
  const [previous] = (await manager.query(
    'SELECT status FROM trip_schema.trips WHERE id = $1 AND status = ANY($2) FOR UPDATE',
    [input.tripId, input.from],
  )) as Array<{ status: TripStatus }>;

  if (!previous) {
    return null;
  }

  const result = await manager
    .createQueryBuilder()
    .update(Trip)
    .set({ status: input.to, version: () => 'version + 1', updatedAt: () => 'now()' })
    .where({ id: input.tripId })
    .returning('*')
    .execute();
  const [row] = result.raw as Array<{ passenger_id: string; version: number; updated_at: Date }>;

  await manager.getRepository(StateHistory).insert({
    id: randomUUID(),
    tripId: input.tripId,
    fromStatus: previous.status,
    toStatus: input.to,
    actorId: input.actorId,
    commandId: input.commandId,
    correlationId: input.correlationId,
    occurredAt: row.updated_at,
  });

  return { passengerId: row.passenger_id, version: row.version };
}
