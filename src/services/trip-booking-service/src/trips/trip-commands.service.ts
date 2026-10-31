import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import type { Actor, Operation as OperationDto, Trip as TripDto, TripStatus } from '@app/contracts';
import { createRideEvent, enqueueOutboxEvent } from '@app/messaging';
import { ApiError, withIdempotencyKey } from '@app/runtime';
import { AcceptTripDto } from './dto/accept-trip.dto';
import { CancelTripDto } from './dto/cancel-trip.dto';
import { RejectTripDto } from './dto/reject-trip.dto';
import { Operation, toOperation } from './entities/operation.entity';
import { Trip, toTrip } from './entities/trip.entity';
import { findCompletedResponse } from './idempotency-replay';
import { MatchingClient } from './matching.client';
import { SagaStore } from './saga/saga.store';
import { transitionTrip } from './trip-transition';
import { TRIP_OUTBOX_TABLE } from './trips.service';

interface OfferCommand<TRequest> {
  actor: Actor;
  tripId: string;
  offerId: string;
  action: 'accept' | 'reject';
  request: TRequest;
  key: string;
  correlationId: string;
  create: (manager: EntityManager, now: Date) => Promise<OperationDto>;
}

function invalidState(): ApiError {
  return new ApiError(409, 'INVALID_STATE', 'Trip state does not allow this action');
}

function respond(operation: Operation, tripStatus: TripStatus): OperationDto {
  return toOperation({ ...operation, trip: { status: tripStatus } as Trip });
}

function assertAssignedDriver(trip: Trip, actor: Actor): void {
  if (trip.driverId !== actor.userId) {
    throw new ApiError(403, 'RESOURCE_FORBIDDEN', 'This trip is assigned to another driver');
  }
}

@Injectable()
export class TripCommandsService {
  private readonly logger = new Logger('TripCommandsService');

  constructor(
    private readonly database: DataSource,
    private readonly matching: MatchingClient,
    private readonly store: SagaStore,
  ) {}

  accept(
    actor: Actor,
    tripId: string,
    dto: AcceptTripDto,
    key: string,
    correlationId: string,
  ): Promise<OperationDto> {
    const offerId = dto.offerId.toLowerCase();

    return this.runOfferCommand({
      actor,
      tripId,
      offerId,
      action: 'accept',
      request: { offerId },
      key,
      correlationId,
      create: async (manager, now) => {
        const assignmentId = randomUUID();
        const updated = await transitionTrip(manager, {
          tripId,
          from: ['MATCHING'],
          to: 'ASSIGNING',
          set: { assignmentId },
          actorId: actor.userId,
          commandId: key,
          correlationId,
        });

        if (!updated) {
          throw invalidState();
        }

        const operation = await this.store.createOperation(manager, {
          tripId,
          actorId: actor.userId,
          type: 'ACCEPT',
          assignmentId,
          offerId,
          correlationId,
          now,
        });

        return respond(operation, 'ASSIGNING');
      },
    });
  }

  reject(
    actor: Actor,
    tripId: string,
    dto: RejectTripDto,
    key: string,
    correlationId: string,
  ): Promise<OperationDto> {
    const offerId = dto.offerId.toLowerCase();

    return this.runOfferCommand({
      actor,
      tripId,
      offerId,
      action: 'reject',
      request: { offerId, reason: dto.reason },
      key,
      correlationId,
      create: async (manager, now) => {
        const trip = await manager.getRepository(Trip).findOneByOrFail({ id: tripId });

        if (trip.status !== 'MATCHING') {
          throw invalidState();
        }

        const operation = await this.store.createOperation(manager, {
          tripId,
          actorId: actor.userId,
          type: 'REJECT',
          assignmentId: null,
          offerId,
          correlationId,
          now,
        });

        return respond(operation, trip.status);
      },
    });
  }

  start(actor: Actor, tripId: string, key: string, correlationId: string): Promise<TripDto> {
    return this.runTripCommand(actor, tripId, 'start', key, 200, {}, async (manager, trip) => {
      assertAssignedDriver(trip, actor);

      const updated = await transitionTrip(manager, {
        tripId,
        from: ['ASSIGNED'],
        to: 'IN_PROGRESS',
        actorId: actor.userId,
        commandId: key,
        correlationId,
      });

      if (!updated) {
        throw invalidState();
      }

      await enqueueOutboxEvent(
        manager,
        TRIP_OUTBOX_TABLE,
        createRideEvent('trip.started', {
          aggregateId: tripId,
          aggregateVersion: updated.version,
          correlationId,
          causationId: key,
          payload: {
            tripId,
            passengerId: updated.passengerId,
            driverId: actor.userId,
            tripVersion: updated.version,
            status: 'IN_PROGRESS',
          },
        }),
      );

      const started = await manager
        .getRepository(Trip)
        .findOneOrFail({ where: { id: tripId }, relations: { fare: true } });

      return toTrip(started);
    });
  }

  complete(actor: Actor, tripId: string, key: string, correlationId: string): Promise<OperationDto> {
    return this.runTripCommand(actor, tripId, 'complete', key, 202, {}, async (manager, trip) => {
      assertAssignedDriver(trip, actor);

      const updated = await transitionTrip(manager, {
        tripId,
        from: ['IN_PROGRESS'],
        to: 'COMPLETED',
        set: { paymentId: randomUUID(), paymentStatus: 'PENDING' },
        actorId: actor.userId,
        commandId: key,
        correlationId,
      });

      if (!updated) {
        throw invalidState();
      }

      await enqueueOutboxEvent(
        manager,
        TRIP_OUTBOX_TABLE,
        createRideEvent('trip.completed', {
          aggregateId: tripId,
          aggregateVersion: updated.version,
          correlationId,
          causationId: key,
          payload: {
            tripId,
            passengerId: updated.passengerId,
            driverId: actor.userId,
            tripVersion: updated.version,
            status: 'COMPLETED',
          },
        }),
      );

      const [{ now }] = (await manager.query('SELECT now() AS now')) as Array<{ now: Date }>;
      const operation = await this.store.createOperation(manager, {
        tripId,
        actorId: actor.userId,
        type: 'COMPLETE',
        assignmentId: trip.assignmentId,
        offerId: null,
        correlationId,
        now,
      });

      return respond(operation, 'COMPLETED');
    });
  }

  cancel(
    actor: Actor,
    tripId: string,
    dto: CancelTripDto,
    key: string,
    correlationId: string,
  ): Promise<OperationDto> {
    const request = { reason: dto.reason };

    return this.runTripCommand(actor, tripId, 'cancel', key, 202, request, async (manager, trip) => {
      if (trip.passengerId !== actor.userId) {
        throw new ApiError(403, 'RESOURCE_FORBIDDEN', 'This trip belongs to another passenger');
      }

      const updated = await transitionTrip(manager, {
        tripId,
        from: ['MATCHING', 'ASSIGNING', 'ASSIGNED'],
        to: 'CANCELLING',
        actorId: actor.userId,
        commandId: key,
        correlationId,
      });

      if (!updated) {
        // Đọc lại vì CAS có thể vừa thua API-24: trạng thái đọc trước đó đã cũ.
        const current = await manager.getRepository(Trip).findOneByOrFail({ id: tripId });

        throw current.status === 'IN_PROGRESS'
          ? new ApiError(409, 'TRIP_ALREADY_STARTED', 'A started trip cannot be cancelled')
          : invalidState();
      }

      const accept = updated.assignmentId
        ? await manager
            .getRepository(Operation)
            .findOneBy({ tripId, assignmentId: updated.assignmentId, type: 'ACCEPT' })
        : null;
      const [{ now }] = (await manager.query('SELECT now() AS now')) as Array<{ now: Date }>;
      const operation = await this.store.createOperation(manager, {
        tripId,
        actorId: actor.userId,
        type: 'CANCEL',
        assignmentId: updated.assignmentId,
        offerId: null,
        driverId: accept?.driverId ?? null,
        reason: dto.reason,
        correlationId,
        now,
      });

      return respond(operation, 'CANCELLING');
    });
  }

  private async runTripCommand<T>(
    actor: Actor,
    tripId: string,
    action: 'start' | 'complete' | 'cancel',
    key: string,
    status: number,
    request: unknown,
    work: (manager: EntityManager, trip: Trip) => Promise<T>,
  ): Promise<T> {
    const scope = {
      schema: 'trip_schema',
      actorId: actor.userId,
      method: 'POST',
      path: '/api/v1/trips/' + tripId + '/' + action,
      key,
    };

    try {
      const result = await withIdempotencyKey(this.database, scope, request, async manager => {
        const trip = await manager.getRepository(Trip).findOneBy({ id: tripId });

        if (!trip) {
          throw new ApiError(404, 'TRIP_NOT_FOUND', 'Trip not found');
        }

        return { status, body: await work(manager, trip) };
      });

      return result.body;
    } catch (error) {
      throw this.toApiError(error);
    }
  }

  private async runOfferCommand<TRequest>(command: OfferCommand<TRequest>): Promise<OperationDto> {
    const { actor, tripId, offerId, action, request, key, correlationId, create } = command;
    const scope = {
      schema: 'trip_schema',
      actorId: actor.userId,
      method: 'POST',
      path: '/api/v1/trips/' + tripId + '/' + action,
      key,
    };

    try {
      const stored = await findCompletedResponse<OperationDto>(this.database, scope, request);

      if (stored) {
        return stored;
      }

      const trip = await this.database.getRepository(Trip).findOneBy({ id: tripId });

      if (!trip) {
        throw new ApiError(404, 'TRIP_NOT_FOUND', 'Trip not found');
      }

      const offer = await this.matching.getOffer(offerId, correlationId);

      if (offer.tripId !== tripId || offer.driverId !== actor.userId) {
        throw new ApiError(403, 'RESOURCE_FORBIDDEN', 'This offer belongs to another driver or trip');
      }

      if (trip.status !== 'MATCHING') {
        throw invalidState();
      }

      if (offer.status !== 'OPEN') {
        throw new ApiError(409, 'OFFER_CONFLICT', 'Offer is no longer open');
      }

      const result = await withIdempotencyKey(this.database, scope, request, async manager => {
        const [{ now }] = (await manager.query('SELECT now() AS now')) as Array<{ now: Date }>;

        return { status: 202, body: await create(manager, now) };
      });

      return result.body;
    } catch (error) {
      throw this.toApiError(error);
    }
  }

  private toApiError(error: unknown): ApiError {
    if (error instanceof ApiError) {
      return error;
    }

    this.logger.error(error instanceof Error ? error.message : String(error));

    return new ApiError(503, 'DEPENDENCY_UNAVAILABLE', 'Trip database unavailable');
  }
}
