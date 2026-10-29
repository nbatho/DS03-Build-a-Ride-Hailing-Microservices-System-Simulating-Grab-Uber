import { ParseUUIDPipe } from '@nestjs/common';
import { ApiError } from './api-error';

/** Pipe cho tham số đường dẫn là UUID; sai thì 400 VALIDATION_ERROR theo dạng lỗi chuẩn. */
export function uuidParam(name: string): ParseUUIDPipe {
  return new ParseUUIDPipe({
    exceptionFactory: () => new ApiError(400, 'VALIDATION_ERROR', name + ' must be a UUID'),
  });
}
