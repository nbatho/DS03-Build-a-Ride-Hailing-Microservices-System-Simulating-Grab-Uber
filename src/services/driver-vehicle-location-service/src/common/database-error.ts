import { ApiError } from '@app/runtime';

export function throwDriverError(error: unknown): never {
  if (error instanceof ApiError) {
    throw error;
  }

  const failure = error as { driverError?: { code?: string; constraint?: string } };
  const constraint = failure?.driverError?.constraint;

  if (failure?.driverError?.code === '23505') {
    if (constraint === 'uq_vehicles_driver') {
      throw new ApiError(409, 'VEHICLE_EXISTS', 'Driver already has a vehicle');
    }

    if (constraint === 'uq_vehicles_plate') {
      throw new ApiError(409, 'PLATE_EXISTS', 'Plate number is already registered');
    }

    if (
      constraint === 'uq_reservations_active_driver' ||
      constraint === 'uq_reservations_active_trip'
    ) {
      throw new ApiError(
        409,
        'DRIVER_UNAVAILABLE',
        'Driver or trip already has an active reservation',
      );
    }
  }

  throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE', 'Driver database unavailable');
}
