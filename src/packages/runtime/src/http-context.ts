import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { isUUID } from 'class-validator';
import type { Actor } from '@app/contracts';
export type ContextRequest = Request & { correlationId: string; actor?: Actor };
export function contextMiddleware(service: string, instanceId: string) {
  return (raw: Request, res: Response, next: NextFunction): void => {
    const req = raw as ContextRequest;
    const supplied = req.headers['x-correlation-id'];
    const valid = typeof supplied === 'string' && isUUID(supplied);
    req.correlationId = valid ? supplied : randomUUID();
    res.setHeader('X-Correlation-Id', req.correlationId);
    const start = performance.now();
    res.on('finish', () => {
      Logger.log(JSON.stringify({
        service, instanceId, timestamp: new Date().toISOString(), level: 'info',
        event: 'http.request', action: req.method, resource: req.route?.path ?? 'unmatched',
        result: res.statusCode, correlationId: req.correlationId,
        actorId: req.actor?.userId, latencyMs: Math.round(performance.now() - start),
      }), 'Audit');
    });
    if (supplied !== undefined && !valid) {
      res.status(400).json({
        code: 'VALIDATION_ERROR', message: 'X-Correlation-Id must be a UUID',
        correlationId: req.correlationId,
      });
      return;
    }
    next();
  };
}
