import { HttpException } from '@nestjs/common';
export class ApiError extends HttpException {
  constructor(status: number, code: string, message: string, details?: string[]) {
    super({ code, message, ...(details ? { details } : {}) }, status);
  }
}
