import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { DataSource, In, type EntityManager } from 'typeorm';
import type {
  Actor,
  Operation as OperationDto,
  Quote,
  RideEvent,
  Trip as TripDto,
  TripsPage,
} from '@app/contracts';
import {
  NonRetryableEventError,
  createRideEvent,
  enqueueOutboxEvent,
  processEventOnce,
} from '@app/messaging';
import { ApiError, withIdempotencyKey } from '@app/runtime';
import { decodeCursor, encodeCursor } from './cursor';
import { CreateTripDto } from './dto/create-trip.dto';
import { ListTripsQueryDto } from './dto/list-trips.query.dto';
import { FareSnapshot } from './entities/fare-snapshot.entity';
import { Operation, toOperation } from './entities/operation.entity';
import { StateHistory } from './entities/state-history.entity';
import { Trip, toTrip, toTripProgress } from './entities/trip.entity';
import { findCompletedResponse } from './idempotency-replay';
import { MatchingClient } from './matching.client';
import { PricingClient } from './pricing.client';
import { transitionTrip } from './trip-transition';

export const TRIP_OUTBOX_TABLE = 'trip_schema.outbox_events';
const TRIP_INBOX = { table: 'trip_schema.processed_events', consumerName: 'trip-booking-service' };
const DEFAULT_PAGE_LIMIT = 20;

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const failure = error as { driverError?: { code?: string; constraint?: string } };

  return failure.driverError?.code === '23505' && failure.driverError.constraint === constraint;
}

@Injectable()
export class TripsService {
  private readonly logger = new Logger('TripsService');

  constructor(
    private readonly database: DataSource,
    private readonly pricing: PricingClient,
    private readonly matching: MatchingClient,
  ) {}

  async createTrip(
    passengerId: string,
    dto: CreateTripDto,
    key: string,
    correlationId: string,
  ): Promise<TripDto> {
    const quoteId = dto.quoteId.toLowerCase();
    const request = { quoteId };
    const scope = {
      schema: 'trip_schema',
      actorId: passengerId,
      method: 'POST',
      path: '/api/v1/trips',
      key,
    };

    try {
      const stored = await findCompletedResponse<TripDto>(this.database, scope, request);

      if (stored) {
        return stored;
      }

      const quote = await this.pricing.getQuote(quoteId, correlationId);
      const result = await withIdempotencyKey(this.database, scope, request, async manager => {
        const [{ now }] = (await manager.query('SELECT now() AS now')) as Array<{ now: Date }>;

        if (quote.passengerId !== passengerId) {
          throw new ApiError(403, 'RESOURCE_FORBIDDEN', 'This quote belongs to another passenger');
        }

        if (new Date(quote.expiresAt) <= now) {
          throw new ApiError(409, 'QUOTE_EXPIRED', 'Quote has expired');
        }

        const trip = await this.insertTrip(manager, quote, key, correlationId, now);

        return { status: 201, body: toTrip(trip) };
      });

      return result.body;
    } catch (error) {
      if (isUniqueViolation(error, 'uq_trips_quote')) {
        throw new ApiError(409, 'QUOTE_ALREADY_USED', 'Quote was already used');
      }

      throw this.toApiError(error);
    }
  }

  async listTrips(actor: Actor, query: ListTripsQueryDto): Promise<TripsPage> {
    const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
    const position = query.cursor ? decodeCursor(query.cursor) : undefined;

    try {
      const builder = this.database
        .getRepository(Trip)
        .createQueryBuilder('trip')
        .innerJoinAndSelect('trip.fare', 'fare')
        .addSelect('CAST(trip.createdAt AS text)', 'created_at_text')
        .where(actor.role === 'DRIVER' ? 'trip.driverId = :actorId' : 'trip.passengerId = :actorId', {
          actorId: actor.userId,
        })
        .orderBy('trip.createdAt', 'DESC')
        .addOrderBy('trip.id', 'DESC')
        .limit(limit + 1);

      if (position) {
        builder.andWhere(
          '(trip.createdAt, trip.id) < (CAST(:cursorTime AS timestamptz), CAST(:cursorId AS uuid))',
          { cursorTime: position.createdAt, cursorId: position.id },
        );
      }

      const { entities, raw } = await builder.getRawAndEntities<{ created_at_text: string }>();
      const page = entities.slice(0, limit);
      const last = page[page.length - 1];

      return {
        items: page.map(toTrip),
        ...(entities.length > limit && last
          ? {
              nextCursor: encodeCursor({
                createdAt: raw[page.length - 1].created_at_text,
                id: last.id,
              }),
            }
          : {}),
      };
    } catch (error) {
      throw this.toApiError(error);
    }
  }

  async getTrip(actor: Actor, tripId: string): Promise<TripDto> {
    try {
      const trip = await this.findTrip(tripId);

      if (actor.userId === trip.passengerId || actor.userId === trip.driverId) {
        return toTrip(trip);
      }

      if (actor.role === 'DRIVER' && (await this.hasActiveAccept(tripId, actor.userId))) {
        return toTripProgress(trip);
      }
    } catch (error) {
      throw this.toApiError(error);
    }

    throw new ApiError(403, 'RESOURCE_FORBIDDEN', 'This trip belongs to another user');
  }

  async getTripForService(tripId: string): Promise<TripDto> {
    try {
      return toTrip(await this.findTrip(tripId));
    } catch (error) {
      throw this.toApiError(error);
    }
  }

  async getOperation(actor: Actor, operationId: string): Promise<OperationDto> {
    let operation: Operation | null;

    try {
      operation = await this.database
        .getRepository(Operation)
        .findOne({ where: { id: operationId }, relations: { trip: true } });
    } catch (error) {
      throw this.toApiError(error);
    }

    if (!operation) {
      throw new ApiError(404, 'OPERATION_NOT_FOUND', 'Operation not found');
    }

    if (actor.userId !== operation.actorId && actor.userId !== operation.trip.passengerId) {
      throw new ApiError(403, 'RESOURCE_FORBIDDEN', 'This operation belongs to another user');
    }

    return toOperation(operation);
  }

  async handleMatchingFailed(event: RideEvent<'matching.failed'>): Promise<void> {
    const { tripId, jobId, jobVersion, reason } = event.payload;

    const trip = await this.database.getRepository(Trip).findOneBy({ id: tripId });

    if (!trip) {
      throw new NonRetryableEventError('TRIP_NOT_FOUND', 'Trip ' + tripId + ' does not exist');
    }

    const confirmed =
      trip.status === 'MATCHING' &&
      (await this.isJobFailed(tripId, jobId, jobVersion, event.correlation_id));

    await processEventOnce(this.database, TRIP_INBOX, event, async manager => {
      if (!confirmed) {
        return;
      }

      const updated = await transitionTrip(manager, {
        tripId,
        from: ['MATCHING'],
        to: 'NO_DRIVER',
        actorId: null,
        commandId: event.event_id,
        correlationId: event.correlation_id,
      });

      if (updated) {
        await enqueueOutboxEvent(
          manager,
          TRIP_OUTBOX_TABLE,
          createRideEvent('trip.no_driver', {
            aggregateId: tripId,
            aggregateVersion: updated.version,
            correlationId: event.correlation_id,
            causationId: event.event_id,
            payload: {
              tripId,
              passengerId: updated.passengerId,
              tripVersion: updated.version,
              reason,
            },
          }),
        );
      }
    });
  }

  private async isJobFailed(
    tripId: string,
    jobId: string,
    jobVersion: number,
    correlationId: string,
  ): Promise<boolean> {
    const job = await this.matching.getJob(tripId, correlationId);

    if (!job) {
      throw new NonRetryableEventError('JOB_NOT_FOUND', 'Trip ' + tripId + ' has no matching job');
    }

    if (job.id !== jobId) {
      throw new NonRetryableEventError('JOB_MISMATCH', 'Trip ' + tripId + ' has a different job');
    }

    if (job.status === 'FAILED' && job.version >= jobVersion) {
      return true;
    }

    this.logger.warn(
      'Ignoring matching.failed for trip ' + tripId + ': job ' + jobId + ' is ' + job.status,
    );

    return false;
  }

  private async insertTrip(
    manager: EntityManager,
    quote: Quote,
    key: string,
    correlationId: string,
    now: Date,
  ): Promise<Trip> {
    const id = randomUUID();
    const trips = manager.getRepository(Trip);
    const fares = manager.getRepository(FareSnapshot);
    const trip = trips.create({
      id,
      passengerId: quote.passengerId,
      driverId: null,
      quoteId: quote.id,
      assignmentId: null,
      pickup: quote.pickup,
      dropoff: quote.dropoff,
      status: 'MATCHING',
      paymentId: null,
      paymentStatus: 'NOT_REQUESTED',
      version: 1,
      createdAt: now,
      updatedAt: now,
    });

    await trips.insert(trip);

    const fare = fares.create({
      tripId: id,
      amount: quote.amount,
      currency: quote.currency,
      ruleVersion: quote.ruleVersion,
      distanceMeters: quote.distanceMeters,
      durationSeconds: quote.durationSeconds,
    });

    await fares.insert(fare);
    await manager.getRepository(StateHistory).insert({
      id: randomUUID(),
      tripId: id,
      fromStatus: null,
      toStatus: 'MATCHING',
      actorId: quote.passengerId,
      commandId: key,
      correlationId,
      occurredAt: now,
    });

    await enqueueOutboxEvent(
      manager,
      TRIP_OUTBOX_TABLE,
      createRideEvent('trip.requested', {
        aggregateId: id,
        aggregateVersion: 1,
        correlationId,
        causationId: key,
        occurredAt: now,
        payload: {
          tripId: id,
          passengerId: quote.passengerId,
          pickup: quote.pickup,
          dropoff: quote.dropoff,
          amount: quote.amount,
          currency: quote.currency,
          tripVersion: 1,
        },
      }),
    );

    trip.fare = fare;

    return trip;
  }

  private async findTrip(tripId: string): Promise<Trip> {
    const trip = await this.database
      .getRepository(Trip)
      .findOne({ where: { id: tripId }, relations: { fare: true } });

    if (!trip) {
      throw new ApiError(404, 'TRIP_NOT_FOUND', 'Trip not found');
    }

    return trip;
  }

  private hasActiveAccept(tripId: string, actorId: string): Promise<boolean> {
    return this.database.getRepository(Operation).existsBy({
      tripId,
      actorId,
      type: 'ACCEPT',
      status: In(['PENDING', 'RUNNING', 'FAILED_NEEDS_REVIEW']),
    });
  }

  private toApiError(error: unknown): ApiError {
    if (error instanceof ApiError) {
      return error;
    }

    this.logger.error(error instanceof Error ? error.message : String(error));

    return new ApiError(503, 'DEPENDENCY_UNAVAILABLE', 'Trip database unavailable');
  }
}
