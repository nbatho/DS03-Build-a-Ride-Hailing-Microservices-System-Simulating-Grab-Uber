import type { DriverStatus, ReservationStatus } from '@app/contracts';

export function isLocationFresh(receivedAt: Date | undefined, now: Date): boolean {
  if (!receivedAt) {
    return false;
  }

  const age = now.getTime() - receivedAt.getTime();

  return age >= 0 && age <= 60000;
}

export function driverStatus(
  online: boolean,
  hasVehicle: boolean,
  locationFresh: boolean,
  reservationStatus?: ReservationStatus,
): DriverStatus {
  if (reservationStatus === 'CONFIRMED') {
    return 'BUSY';
  }

  if (reservationStatus === 'HELD') {
    return 'RESERVED';
  }

  return online && hasVehicle && locationFresh ? 'AVAILABLE' : 'OFFLINE';
}
