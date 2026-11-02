import { Injectable } from '@nestjs/common';
import type {
  CancelJobRequest,
  MatchingJob,
  Offer,
  OfferDecisionRequest,
  OfferResolutionRequest,
} from '@app/contracts';
import { ApiError, InternalHttpClient } from '@app/runtime';
import { readJob, readOffer, readResult, type UpstreamResult } from './upstream-contracts';

@Injectable()
export class MatchingClient {
  constructor(private readonly http: InternalHttpClient) {}

  async getJob(tripId: string, correlationId: string): Promise<MatchingJob | null> {
    const response = await this.http.request('MATCHING', {
      method: 'GET',
      path: '/internal/v1/matching/jobs/' + tripId,
      correlationId,
      retry: true,
    });

    if (response.status === 404) {
      return null;
    }

    if (response.status !== 200) {
      throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE', 'Matching is unavailable');
    }

    return readJob(response.body, tripId);
  }

  async cancelJob(
    tripId: string,
    body: CancelJobRequest,
    correlationId: string,
  ): Promise<UpstreamResult<MatchingJob>> {
    const response = await this.http.request('MATCHING', {
      method: 'POST',
      path: '/internal/v1/matching/jobs/' + tripId + '/cancel',
      correlationId,
      body,
      retry: true,
    });

    return readResult('Matching', response, value => readJob(value, tripId));
  }

  async getOffer(offerId: string, correlationId: string): Promise<Offer> {
    const response = await this.http.request('MATCHING', {
      method: 'GET',
      path: '/internal/v1/offers/' + offerId,
      correlationId,
      retry: true,
    });

    if (response.status === 404) {
      throw new ApiError(404, 'OFFER_NOT_FOUND', 'Offer not found');
    }

    if (response.status !== 200) {
      throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE', 'Matching is unavailable');
    }

    return readOffer(response.body, offerId);
  }

  async decideOffer(
    offerId: string,
    body: OfferDecisionRequest,
    correlationId: string,
  ): Promise<UpstreamResult<Offer>> {
    const response = await this.http.request('MATCHING', {
      method: 'POST',
      path: '/internal/v1/offers/' + offerId + '/decisions',
      correlationId,
      body,
      retry: true,
    });

    return readResult('Matching', response, value => readOffer(value, offerId));
  }

  async resolveOffer(
    offerId: string,
    body: OfferResolutionRequest,
    correlationId: string,
  ): Promise<UpstreamResult<Offer>> {
    const response = await this.http.request('MATCHING', {
      method: 'POST',
      path: '/internal/v1/offers/' + offerId + '/resolution',
      correlationId,
      body,
      retry: true,
    });

    return readResult('Matching', response, value => readOffer(value, offerId));
  }
}
