import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { Offer } from '@app/contracts';
import type { InternalCaller } from '@app/shared-types';
import { ApiError, withCommandResult } from '@app/runtime';
import { MatchingStateService, throwMatchingError, toOffer } from './matching-state.service';
import { OfferEntity } from './entities/offer.entity';
import { OfferDecisionDto } from './dto/offer-decision.dto';
import { OfferResolutionDto } from './dto/offer-resolution.dto';

@Injectable()
export class OffersService {
  constructor(
    private readonly database: DataSource,
    private readonly state: MatchingStateService,
  ) {}

  async getOffer(offerId: string): Promise<Offer> {
    try {
      const offer = await this.database.getRepository(OfferEntity).findOneBy({ id: offerId });

      if (!offer) {
        throw new ApiError(404, 'OFFER_NOT_FOUND', 'Offer not found');
      }

      return toOffer(offer);
    } catch (error) {
      throwMatchingError(error);
    }
  }

  async decideOffer(
    offerId: string,
    dto: OfferDecisionDto,
    caller: InternalCaller,
    correlationId: string,
  ): Promise<Offer> {
    try {
      const result = await withCommandResult(
        this.database,
        {
          schema: 'matching_schema',
          callerService: caller,
          commandType: 'DECISION',
          commandId: dto.assignmentId,
          resourceId: offerId,
          correlationId,
        },
        dto,
        async manager => {
          const { job, offer } = await this.state.lockOffer(manager, offerId);

          if (offer.driverId !== dto.driverId) {
            throw new ApiError(403, 'DRIVER_MISMATCH', 'Offer belongs to another driver');
          }

          if (offer.tripId !== dto.tripId) {
            throw new ApiError(409, 'OFFER_CONFLICT', 'Offer belongs to another trip');
          }

          if (job.status === 'CANCELLED') {
            throw new ApiError(409, 'JOB_CANCELLED', 'Matching job was cancelled');
          }

          const now = await this.state.now(manager);

          if (
            offer.status === 'EXPIRED' ||
            (offer.status === 'OPEN' &&
              (offer.expiresAt.getTime() <= now.getTime() ||
                job.searchDeadline!.getTime() <= now.getTime()))
          ) {
            throw new ApiError(409, 'OFFER_EXPIRED', 'Offer has expired');
          }

          if (
            offer.status !== 'OPEN' ||
            job.status !== 'OFFERING' ||
            job.currentOfferId !== offer.id
          ) {
            throw new ApiError(409, 'OFFER_CONFLICT', 'Offer is no longer open');
          }

          offer.assignmentId = dto.assignmentId;
          offer.decisionAction = dto.action;
          offer.status = dto.action === 'ACCEPT' ? 'CLAIMED' : 'REJECTED';
          await this.state.saveOffer(manager, offer);
          job.status = dto.action === 'ACCEPT' ? 'CLAIMED' : 'SEARCHING';

          if (dto.action === 'REJECT') {
            job.currentOfferId = null;
          }

          await this.state.saveJob(manager, job, dto.action === 'ACCEPT' ? 5000 : 0);

          return { status: 200, body: toOffer(offer) };
        },
      );

      return result.body;
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.getResponse() as { code?: string }).code === 'PAYLOAD_MISMATCH'
      ) {
        throw new ApiError(
          409,
          'OFFER_CONFLICT',
          'Assignment ID was already used with a different decision',
        );
      }

      throwMatchingError(error);
    }
  }

  async resolveOffer(
    offerId: string,
    dto: OfferResolutionDto,
    caller: InternalCaller,
    correlationId: string,
  ): Promise<Offer> {
    try {
      const result = await withCommandResult(
        this.database,
        {
          schema: 'matching_schema',
          callerService: caller,
          commandType: 'RESOLUTION',
          commandId: dto.commandId,
          resourceId: offerId,
          correlationId,
        },
        dto,
        async manager => {
          const { job, offer } = await this.state.lockOffer(manager, offerId);

          if (
            offer.tripId !== dto.tripId ||
            offer.assignmentId !== dto.assignmentId ||
            offer.decisionAction !== 'ACCEPT'
          ) {
            throw new ApiError(
              409,
              'ASSIGNMENT_MISMATCH',
              'Resolution does not belong to the claimed assignment',
            );
          }

          await this.state.resolve(manager, job, offer, dto.result);

          return { status: 200, body: toOffer(offer) };
        },
      );

      return result.body;
    } catch (error) {
      throwMatchingError(error);
    }
  }
}
