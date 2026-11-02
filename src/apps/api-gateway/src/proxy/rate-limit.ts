import { Injectable, type NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '@app/runtime';
import { API_PREFIX, requestTarget } from './routes';

// Giới hạn số request theo IP tại Gateway (BA mục 4.1: 429 gọi quá nhiều; mục 10.1; test S03).
// Chạy trước kiểm tra JWT để request rác cũng bị chặn sớm. Đếm trong RAM của một instance Gateway:
// đủ cho demo một instance; nhiều instance thì mỗi instance đếm riêng.
//   GATEWAY_AUTH_RATE_LIMIT        đăng ký/đăng nhập, mặc định 10/phút/IP (khớp giới hạn của Tài khoản)
//   GATEWAY_RATE_LIMIT_PER_MINUTE  mọi đường khác, mặc định 300/phút/IP
// Đặt 0 để tắt (ví dụ khi chạy test tải từ một máy).

export const RATE_WINDOW_MS = 60_000;
const COUNTED = Symbol('ds03.rateLimitCounted');
const AUTH_PATHS = new Set([API_PREFIX + '/auth/login', API_PREFIX + '/auth/register']);

export interface RateLimitConfig {
  authPerMinute: number;
  generalPerMinute: number;
}

function limitFrom(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value < 0) {
    throw new Error(name + ' must be a non-negative integer (0 disables the limit)');
  }

  return value;
}

export function loadRateLimitConfig(env: NodeJS.ProcessEnv): RateLimitConfig {
  return {
    authPerMinute: limitFrom(env.GATEWAY_AUTH_RATE_LIMIT, 'GATEWAY_AUTH_RATE_LIMIT', 10),
    generalPerMinute: limitFrom(env.GATEWAY_RATE_LIMIT_PER_MINUTE, 'GATEWAY_RATE_LIMIT_PER_MINUTE', 300),
  };
}

interface Window {
  startedAt: number;
  count: number;
}

/** Cửa sổ cố định 60 giây theo (nhóm, IP). Trả về số giây phải chờ nếu vượt, undefined nếu còn lượt. */
export class FixedWindowLimiter {
  private readonly windows = new Map<string, Window>();

  private lastSweep = 0;

  constructor(private readonly now: () => number = Date.now) {}

  hit(key: string, limit: number): number | undefined {
    const now = this.now();

    this.sweep(now);

    let window = this.windows.get(key);

    if (!window || now - window.startedAt >= RATE_WINDOW_MS) {
      window = { startedAt: now, count: 0 };
      this.windows.set(key, window);
    }

    window.count += 1;

    if (window.count <= limit) {
      return undefined;
    }

    return Math.max(1, Math.ceil((window.startedAt + RATE_WINDOW_MS - now) / 1000));
  }

  /** Bỏ cửa sổ đã hết hạn, tối đa mỗi phút một lần, để bộ nhớ không tăng theo số IP. */
  private sweep(now: number): void {
    if (now - this.lastSweep < RATE_WINDOW_MS) {
      return;
    }

    this.lastSweep = now;

    for (const [key, window] of this.windows) {
      if (now - window.startedAt >= RATE_WINDOW_MS) {
        this.windows.delete(key);
      }
    }
  }
}

@Injectable()
export class RateLimitMiddleware implements NestMiddleware {
  private readonly config: RateLimitConfig;

  private readonly limiter = new FixedWindowLimiter();

  constructor(_config: ConfigService) {
    // ConfigService được inject để chắc .env đã nạp; giá trị sai thì dừng khi khởi động.
    this.config = loadRateLimitConfig(process.env);
  }

  use(req: Request, res: Response, next: NextFunction): void {
    const marked = req as Request & { [COUNTED]?: true };

    // Một đường có thể khớp nhiều route (handler riêng + route bắt-tất-cả) nên middleware chạy nhiều lần; chỉ đếm lần đầu.
    if (marked[COUNTED]) {
      next();

      return;
    }

    marked[COUNTED] = true;

    const { pathname } = requestTarget(req.originalUrl);

    // Chỉ giới hạn đường chuyển tiếp; /health/* phải luôn trả lời được để kiểm tra sống/sẵn sàng.
    if (!pathname.startsWith(API_PREFIX + '/')) {
      next();

      return;
    }

    const auth = AUTH_PATHS.has(pathname);
    const limit = auth ? this.config.authPerMinute : this.config.generalPerMinute;

    if (limit > 0) {
      // Gateway không tin X-Forwarded-For (trust proxy tắt), nên req.ip là địa chỉ socket thật.
      const client = req.ip ?? req.socket.remoteAddress ?? 'unknown';
      const retryAfter = this.limiter.hit((auth ? 'auth:' : 'api:') + client, limit);

      if (retryAfter !== undefined) {
        res.setHeader('Retry-After', String(retryAfter));
        throw new ApiError(429, 'RATE_LIMITED', 'Too many requests, retry after ' + retryAfter + 's');
      }
    }

    next();
  }
}
