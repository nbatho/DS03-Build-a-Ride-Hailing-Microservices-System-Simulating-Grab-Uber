import { ApiError } from './api-error';

export async function withDatabase<T>(service: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE', service + ' database unavailable');
  }
}
