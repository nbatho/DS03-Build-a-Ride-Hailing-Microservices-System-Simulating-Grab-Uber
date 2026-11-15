import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { TRIP_STATUSES, type TripPaymentStatus, type TripStatus } from '@app/contracts';
import { StateHistory } from './entities/state-history.entity';
import { Trip } from './entities/trip.entity';

/**
 * Vòng đời chuyến: nguồn duy nhất của các bước chuyển hợp lệ. Mọi thay đổi trạng thái đi qua transitionTrip,
 * hàm này tự suy ra trạng thái nguồn từ bảng nên chỗ gọi không tự liệt kê được bước sai.
 * Trạng thái không có bước đi tiếp là trạng thái cuối.
 */
export const TRIP_TRANSITIONS: Readonly<Record<TripStatus, readonly TripStatus[]>> = {
  MATCHING: ['ASSIGNING', 'NO_DRIVER', 'CANCELLING'],
  ASSIGNING: ['ASSIGNED', 'MATCHING', 'CANCELLING'],
  ASSIGNED: ['IN_PROGRESS', 'CANCELLING'],
  IN_PROGRESS: ['COMPLETED'],
  CANCELLING: ['CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
  NO_DRIVER: [],
};

export function canTransition(from: TripStatus, to: TripStatus): boolean {
  return TRIP_TRANSITIONS[from].includes(to);
}

/** Các trạng thái được phép chuyển sang `to`; rỗng nếu `to` không thể là đích (MATCHING khi tạo chuyến). */
export function sourcesOf(to: TripStatus): TripStatus[] {
  return TRIP_STATUSES.filter(from => canTransition(from, to));
}

export interface TripTransition {
  tripId: string;
  to: TripStatus;
  assignmentId?: string;
  set?: {
    driverId?: string;
    assignmentId?: string | null;
    paymentId?: string;
    paymentStatus?: TripPaymentStatus;
  };
  actorId: string | null;
  commandId: string;
  correlationId: string;
}

export interface TransitionedTrip {
  passengerId: string;
  assignmentId: string | null;
  version: number;
}

/**
 * Chuyển chuyến sang `to` nếu trạng thái hiện tại cho phép theo TRIP_TRANSITIONS (khóa dòng, tăng version,
 * ghi lịch sử). null khi chuyến không ở trạng thái nguồn hợp lệ hoặc assignmentId không khớp.
 */
export async function transitionTrip(
  manager: EntityManager,
  input: TripTransition,
): Promise<TransitionedTrip | null> {
  const from = sourcesOf(input.to);

  if (from.length === 0) {
    throw new Error('No trip status can transition to ' + input.to);
  }

  const [previous] = (await manager.query(
    `SELECT status FROM trip_schema.trips
      WHERE id = $1 AND status = ANY($2) AND ($3::uuid IS NULL OR assignment_id = $3)
      FOR UPDATE`,
    [input.tripId, from, input.assignmentId ?? null],
  )) as Array<{ status: TripStatus }>;

  if (!previous) {
    return null;
  }

  const result = await manager
    .createQueryBuilder()
    .update(Trip)
    .set({ ...input.set, status: input.to, version: () => 'version + 1', updatedAt: () => 'now()' })
    .where({ id: input.tripId })
    .returning('*')
    .execute();
  const [row] = result.raw as Array<{
    passenger_id: string;
    assignment_id: string | null;
    version: number;
    updated_at: Date;
  }>;

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

  return { passengerId: row.passenger_id, assignmentId: row.assignment_id, version: row.version };
}
