import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { ContextRequest } from './http-context';
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<ContextRequest>();
    const candidate = error as { status?: number; type?: string };
    let status = error instanceof HttpException ? error.getStatus() : 500;
    if (candidate?.type === 'entity.too.large') status = 413;
    if (candidate?.type === 'entity.parse.failed') status = 400;
    const defaults: Record<number, [string, string]> = {
      400: ['VALIDATION_ERROR', 'Invalid request'],
      401: ['INVALID_TOKEN', 'Authentication required'],
      403: ['ROLE_FORBIDDEN', 'Access denied'],
      404: ['NOT_FOUND', 'Resource not found'],
      413: ['PAYLOAD_TOO_LARGE', 'JSON body exceeds 64 KiB'],
      429: ['RATE_LIMITED', 'Too many requests'],
      500: ['INTERNAL_ERROR', 'Internal server error'],
      502: ['BAD_GATEWAY', 'Upstream unavailable'],
      503: ['DEPENDENCY_UNAVAILABLE', 'Dependency unavailable'],
      504: ['GATEWAY_TIMEOUT', 'Upstream deadline exceeded'],
    };
    const [defaultCode, defaultMessage] = defaults[status] ?? defaults[500];
    const body = error instanceof HttpException ? error.getResponse() : undefined;
    const detail = typeof body === 'object' && body !== null
      ? body as { code?: string; message?: string | string[]; details?: string[] }
      : undefined;
    const correlationId = req.correlationId ?? randomUUID();
    res.setHeader('X-Correlation-Id', correlationId);
    res.status(status).json({
      code: detail?.code ?? defaultCode,
      message: detail?.code && typeof detail.message === 'string' ? detail.message : defaultMessage,
      correlationId,
      ...(Array.isArray(detail?.message) ? { details: detail.message } : {}),
      ...(detail?.details ? { details: detail.details } : {}),
    });
  }
}
