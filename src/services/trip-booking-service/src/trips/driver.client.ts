import { Injectable } from '@nestjs/common';
import type {
  ConfirmReservationRequest,
  ReleaseReservationRequest,
  Reservation,
  ReservationRequest,
} from '@app/contracts';
import { InternalHttpClient } from '@app/runtime';
import { readReservation, readResult, type UpstreamResult } from './upstream-contracts';

const PATH = '/internal/v1/reservations/';

@Injectable()
export class DriverClient {
  constructor(private readonly http: InternalHttpClient) {}

  async reserve(
    reservationId: string,
    body: ReservationRequest,
    correlationId: string,
  ): Promise<UpstreamResult<Reservation>> {
    const response = await this.http.request('DRIVER', {
      method: 'PUT',
      path: PATH + reservationId,
      correlationId,
      body,
      retry: true,
    });

    return readResult('Driver', response, value =>
      readReservation(value, reservationId, body.tripId, body.driverId),
    );
  }

  async confirm(
    reservationId: string,
    body: ConfirmReservationRequest,
    correlationId: string,
  ): Promise<UpstreamResult<Reservation>> {
    const response = await this.http.request('DRIVER', {
      method: 'POST',
      path: PATH + reservationId + '/confirm',
      correlationId,
      body,
      retry: true,
    });

    return readResult('Driver', response, value =>
      readReservation(value, reservationId, body.tripId, body.driverId),
    );
  }

  async release(
    reservationId: string,
    body: ReleaseReservationRequest,
    correlationId: string,
  ): Promise<UpstreamResult<Reservation>> {
    const response = await this.http.request('DRIVER', {
      method: 'POST',
      path: PATH + reservationId + '/release',
      correlationId,
      body,
      retry: true,
    });

    return readResult('Driver', response, value =>
      readReservation(value, reservationId, body.tripId, body.driverId),
    );
  }
}
