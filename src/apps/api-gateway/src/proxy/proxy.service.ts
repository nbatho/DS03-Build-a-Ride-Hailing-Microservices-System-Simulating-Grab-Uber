import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { ApiError, type ContextRequest } from '@app/runtime';
import type { Request } from 'express';
@Injectable()
export class ProxyService {
  private readonly baseUrl: string;
  constructor(config: ConfigService) {
    const value = config.get<string>('IDENTITY_BASE_URL') ?? 'http://127.0.0.1:3001';
    try {
      const parsed = new URL(value);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error();
      this.baseUrl = parsed.origin;
    } catch { throw new Error('IDENTITY_BASE_URL must be a configured HTTP origin'); }
  }
  async identity(raw: Request, res: Response): Promise<void> {
    const req = raw as ContextRequest;
    const headers: Record<string, string> = { 'X-Correlation-Id': req.correlationId, 'Content-Type': 'application/json' };
    if (req.headers.authorization) headers.Authorization = req.headers.authorization;
    // Forward the gateway-validated client IP only, never client-supplied forwarding/service/actor headers.
    headers['X-Forwarded-For'] = req.ip ?? req.socket.remoteAddress ?? '';
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(this.baseUrl + req.originalUrl, {
        method: req.method, headers, redirect: 'error', signal: AbortSignal.timeout(10000),
        ...(req.method === 'POST' ? { body: JSON.stringify(req.body ?? {}) } : {}),
      });
    } catch (error) {
      const timeout = error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name);
      throw new ApiError(timeout ? 504 : 502, timeout ? 'GATEWAY_TIMEOUT' : 'BAD_GATEWAY', 'Identity upstream unavailable');
    }
    const retry = upstream.headers.get('retry-after');
    if (retry) res.setHeader('Retry-After', retry);
    try { res.status(upstream.status).json(await upstream.json()); }
    catch { throw new ApiError(502, 'BAD_GATEWAY', 'Invalid Identity response'); }
  }
}
