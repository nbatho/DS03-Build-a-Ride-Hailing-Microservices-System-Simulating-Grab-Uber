import { setTimeout as sleep } from 'node:timers/promises';
import { Inject, Injectable } from '@nestjs/common';
import { SERVICE_CALLER_NAME, type InternalCaller, type ServiceName } from '@app/shared-types';
import { ApiError } from './api-error';
import { SERVICE_NAME } from './health.controller';
import { outboundToken, SERVICE_TOKEN_HEADER } from './internal-auth';

// BA mục 4.2: chờ 2 giây mỗi lần, tối đa 3 lần, nghỉ 0,5 giây rồi 1,5 giây cộng một khoảng ngẫu nhiên nhỏ.
const ATTEMPT_TIMEOUT_MS = 2000;
const RETRY_DELAYS_MS = [500, 1500];
const MAX_JITTER_MS = 100;
const RETRYABLE_STATUS = new Set([502, 503, 504]);
// Lỗi xảy ra trước khi request tới được bên nhận: chắc chắn chưa ghi gì.
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

export interface InternalRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Đường dẫn nội bộ, ví dụ /internal/v1/quotes/{id}. */
  path: string;
  correlationId: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Chỉ bật cho lệnh chống trùng được (GET, hoặc lệnh có mã lệnh/Idempotency-Key). Lỗi 4xx không bao giờ thử lại. */
  retry: boolean;
}

export interface InternalResponse<T> { status: number; body: T }

/**
 * Hết số lần thử mà không có phản hồi dùng được. outcomeUnknown = true nghĩa là có lần gửi có thể đã được ghi
 * (quá thời gian hoặc 5xx): bên gọi phải đối soát bằng cùng mã, không coi là chắc chắn thất bại.
 */
export class InternalCallError extends ApiError {
  constructor(readonly receiver: InternalCaller, readonly outcomeUnknown: boolean, readonly lastStatus?: number) {
    super(503, 'DEPENDENCY_UNAVAILABLE', receiver + ' is unavailable');
  }
}

@Injectable()
export class InternalHttpClient {
  private readonly caller: InternalCaller | undefined;
  private readonly baseUrls = new Map<InternalCaller, string>();

  constructor(@Inject(SERVICE_NAME) serviceName: ServiceName) {
    this.caller = SERVICE_CALLER_NAME[serviceName];
  }

  /** Trả mọi phản hồi 2xx/4xx/5xx cuối cùng cho bên gọi tự xử lý mã lỗi nghiệp vụ. */
  async request<T = unknown>(receiver: InternalCaller, req: InternalRequest): Promise<InternalResponse<T>> {
    if (!this.caller) throw new Error('This app has no internal caller name');
    const url = this.baseUrl(receiver) + req.path;
    const headers: Record<string, string> = {
      ...req.headers,
      [SERVICE_TOKEN_HEADER]: outboundToken(process.env, this.caller, receiver),
      'X-Correlation-Id': req.correlationId,
      ...(req.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    };
    const attempts = req.retry ? RETRY_DELAYS_MS.length + 1 : 1;
    let outcomeUnknown = false;
    let lastStatus: number | undefined;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1] + Math.floor(Math.random() * MAX_JITTER_MS));
      try {
        const res = await fetch(url, {
          method: req.method, headers, redirect: 'error', signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
          ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
        });
        const text = await res.text();
        if (RETRYABLE_STATUS.has(res.status) && attempt < attempts - 1) {
          outcomeUnknown = true;
          lastStatus = res.status;
          continue;
        }
        return { status: res.status, body: this.parse<T>(receiver, text) };
      } catch (error) {
        if (error instanceof ApiError) throw error;
        const code = (error as { cause?: { code?: string } }).cause?.code;
        if (!code || !NOT_SENT_CODES.has(code)) outcomeUnknown = true;
      }
    }
    throw new InternalCallError(receiver, outcomeUnknown, lastStatus);
  }

  private parse<T>(receiver: InternalCaller, text: string): T {
    if (!text) return undefined as T;
    try { return JSON.parse(text) as T; }
    catch { throw new ApiError(502, 'BAD_GATEWAY', 'Invalid response from ' + receiver); }
  }

  private baseUrl(receiver: InternalCaller): string {
    const cached = this.baseUrls.get(receiver);
    if (cached) return cached;
    const name = receiver + '_BASE_URL';
    try {
      const parsed = new URL(process.env[name] ?? '');
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
        || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error();
      this.baseUrls.set(receiver, parsed.origin);
      return parsed.origin;
    } catch {
      throw new Error(name + ' must be a configured HTTP origin, for example http://127.0.0.1:3002');
    }
  }
}
