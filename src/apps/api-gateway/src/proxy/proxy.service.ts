import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { ApiError, type ContextRequest } from '@app/runtime';
import { UPSTREAMS, matchRoute, pathAllowsOtherMethod, type GatewayRoute, type Upstream } from './routes';

/** Chờ service phía sau tối đa 10 giây (BA mục 4.2); không tự gửi lại request. */
export const UPSTREAM_TIMEOUT_MS = 10_000;

// Header client được chuyển tiếp. Mọi header khác (X-Service-Token, X-User-Id, X-Role, X-Forwarded-*...) bị bỏ.
const FORWARDED_REQUEST_HEADERS = ['authorization', 'idempotency-key', 'accept-language'] as const;
// Header của service phía sau được trả lại cho client.
const FORWARDED_RESPONSE_HEADERS = ['retry-after', 'location'] as const;

function originOf(name: string, value: string): string {
  try {
    const parsed = new URL(value);

    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== '/'
    ) {
      throw new Error();
    }

    return parsed.origin;
  } catch {
    throw new Error(name + ' must be a configured HTTP origin');
  }
}

@Injectable()
export class ProxyService {
  private readonly origins: Record<Upstream, string>;

  constructor(config: ConfigService) {
    // Địa chỉ service chỉ lấy từ env, không bao giờ từ request. Sai định dạng thì dừng khi khởi động.
    this.origins = Object.fromEntries(
      Object.entries(UPSTREAMS).map(([name, upstream]) => [
        name,
        originOf(upstream.env, config.get<string>(upstream.env) ?? upstream.fallback),
      ]),
    ) as Record<Upstream, string>;
  }

  /** Tìm route trong danh sách cho phép; không có thì 404 (hoặc 405 nếu chỉ sai method). */
  resolve(req: Request): { route: GatewayRoute; pathname: string; search: string } {
    const url = new URL(req.originalUrl, 'http://gateway.local');
    const route = matchRoute(req.method, url.pathname);

    if (!route) {
      if (pathAllowsOtherMethod(url.pathname)) {
        throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed for this route');
      }

      throw new ApiError(404, 'NOT_FOUND', 'Route not found');
    }

    return { route, pathname: url.pathname, search: url.search };
  }

  async forward(raw: Request, res: Response): Promise<void> {
    const req = raw as ContextRequest;
    const { route, pathname, search } = this.resolve(req);
    const headers: Record<string, string> = {
      'X-Correlation-Id': req.correlationId,
      Accept: 'application/json',
      // Chỉ IP Gateway thấy được, không lấy X-Forwarded-For do client gửi.
      'X-Forwarded-For': req.ip ?? req.socket.remoteAddress ?? '',
    };

    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = req.headers[name];

      if (typeof value === 'string') {
        headers[name] = value;
      }
    }

    const hasBody = route.method !== 'GET';

    if (hasBody) {
      headers['Content-Type'] = 'application/json';
    }

    let upstream: globalThis.Response;

    try {
      upstream = await fetch(this.origins[route.upstream] + pathname + search, {
        method: route.method,
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        ...(hasBody ? { body: JSON.stringify(req.body ?? {}) } : {}),
      });
    } catch (error) {
      const timeout = error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name);

      // 504 không chứng minh request chưa được ghi; client dùng lại Idempotency-Key để hỏi kết quả.
      throw new ApiError(
        timeout ? 504 : 502,
        timeout ? 'GATEWAY_TIMEOUT' : 'BAD_GATEWAY',
        route.upstream.toLowerCase() + ' upstream unavailable',
      );
    }

    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);

      if (value) {
        res.setHeader(name, value);
      }
    }

    const text = await upstream.text();

    if (!text) {
      res.status(upstream.status).end();

      return;
    }

    let body: unknown;

    try {
      body = JSON.parse(text);
    } catch {
      throw new ApiError(502, 'BAD_GATEWAY', 'Invalid ' + route.upstream.toLowerCase() + ' response');
    }

    res.status(upstream.status).json(body);
  }
}
