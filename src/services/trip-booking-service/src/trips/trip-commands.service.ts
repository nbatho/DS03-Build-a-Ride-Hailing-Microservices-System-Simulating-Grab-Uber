import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import type { Actor, Operation as OperationDto, TripStatus } from '@app/contracts';
import { ApiError, withIdempotencyKey } from '@app/runtime';
import { AcceptTripDto } from './dto/accept-trip.dto';
import { RejectTripDto } from './dto/reject-trip.dto';
import { toOperation, type Operation } from './entities/operation.entity';
import { Trip } from './entities/trip.entity';
import { findCompletedResponse } from './idempotency-replay';
import { MatchingClient } from './matching.client';
import { SagaStore } from './saga/saga.store';
import { transitionTrip } from './trip-transition';

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
  return new ApiError(409, 'INVALID_STATE', 'Trip is not waiting for a driver');
}

function respond(operation: Operation, tripStatus: TripStatus): OperationDto {
  return toOperation({ ...operation, trip: { status: tripStatus } as Trip });
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
      if (error instanceof ApiError) {
        throw error;
      }

      this.logger.error(error instanceof Error ? error.message : String(error));

      throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE', 'Trip database unavailable');
    }
  }
}
