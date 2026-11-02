import { createHash, timingSafeEqual } from 'node:crypto';
import {
  applyDecorators, CanActivate, createParamDecorator, ExecutionContext, Inject, Injectable, Logger, SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { INTERNAL_CALLERS, PUBLIC_ROUTE_METADATA, type InternalCaller } from '@app/shared-types';
import { ApiError } from './api-error';
import type { ContextRequest } from './http-context';

export const SERVICE_TOKEN_HEADER = 'X-Service-Token';
export const INTERNAL_CALLERS_METADATA = 'ds03.internal-callers';
export const INBOUND_SERVICE_TOKENS = Symbol('INBOUND_SERVICE_TOKENS');

const TOKEN_FORMAT = /^[A-Za-z0-9_-]{32,256}$/;

export interface InboundToken { caller: InternalCaller; hash: Buffer }

export function serviceTokenEnv(caller: InternalCaller, receiver: InternalCaller): string {
  return 'SVC_TOKEN_' + caller + '_' + receiver;
}

function readToken(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  if (!value) return undefined;
  if (!TOKEN_FORMAT.test(value)) {
    throw new Error(name + ' must be 32-256 characters [A-Za-z0-9_-]; run npm run svc:tokens');
  }
  return value;
}

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Token mà bên nhận chấp nhận: mỗi bên gọi một biến SVC_TOKEN_<BÊN GỌI>_<receiver>. Biến rỗng = bên đó chưa được cấp. */
export function loadInboundTokens(env: NodeJS.ProcessEnv, receiver: InternalCaller | undefined): InboundToken[] {
  if (!receiver) return [];
  const tokens: InboundToken[] = [];
  for (const caller of INTERNAL_CALLERS) {
    if (caller === receiver) continue;
    const name = serviceTokenEnv(caller, receiver);
    const value = readToken(env, name);
    if (!value) continue;
    const hash = sha256(value);
    // Hai bên gọi dùng chung token thì bên nhận không biết ai gọi.
    if (tokens.some(token => token.hash.equals(hash))) throw new Error(name + ' must differ from other service tokens');
    tokens.push({ caller, hash });
  }
  return tokens;
}

/** Token bên gọi gửi đi; thiếu cấu hình thì báo lỗi ngay khi gọi, không gửi request không có token. */
export function outboundToken(env: NodeJS.ProcessEnv, caller: InternalCaller, receiver: InternalCaller): string {
  const name = serviceTokenEnv(caller, receiver);
  const value = readToken(env, name);
  if (!value) throw new Error(name + ' is not configured; run npm run svc:tokens');
  return value;
}

/**
 * Đánh dấu API nội bộ và danh sách bên được gọi, ví dụ @InternalRoute('TRIP').
 * Route này không dùng JWT người dùng (đánh dấu public với JwtAuthGuard); InternalCallerGuard kiểm tra X-Service-Token thay thế.
 */
export function InternalRoute(...callers: [InternalCaller, ...InternalCaller[]]) {
  return applyDecorators(
    SetMetadata(INTERNAL_CALLERS_METADATA, callers),
    SetMetadata(PUBLIC_ROUTE_METADATA, true),
  );
}

/** Bên gọi đã được InternalCallerGuard xác định từ token, không phải tên do bên gọi tự khai. */
export const CurrentCaller = createParamDecorator(
  (_data: unknown, context: ExecutionContext): InternalCaller | undefined =>
    context.switchToHttp().getRequest<ContextRequest>().internalCaller,
);

function deny(status: 401 | 403, message: string): never {
  throw new ApiError(status, 'INTERNAL_CALLER_FORBIDDEN', message);
}

@Injectable()
export class InternalCallerGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(INBOUND_SERVICE_TOKENS) private readonly tokens: InboundToken[],
  ) {
    Logger.log('Accepted internal callers: ' + (tokens.map(token => token.caller).join(', ') || 'none'), 'InternalAuth');
  }

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<ContextRequest>();
    const allowed = this.reflector.getAllAndOverride<InternalCaller[] | undefined>(INTERNAL_CALLERS_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!allowed) {
      // Chặn mặc định: route /internal/ quên khai @InternalRoute thì không ai gọi được.
      if (req.path.startsWith('/internal/')) deny(403, 'Internal route has no caller allowlist');
      return true;
    }
    const caller = this.identify(req.headers[SERVICE_TOKEN_HEADER.toLowerCase()]);
    if (!caller) deny(401, 'Invalid or missing service token');
    if (!allowed.includes(caller)) deny(403, 'Caller is not permitted');
    req.internalCaller = caller;
    return true;
  }

  private identify(header: string | string[] | undefined): InternalCaller | undefined {
    if (typeof header !== 'string' || !TOKEN_FORMAT.test(header)) return undefined;
    const hash = sha256(header);
    let found: InternalCaller | undefined;
    // So hết danh sách bằng so sánh thời gian hằng, không dừng sớm.
    for (const token of this.tokens) {
      if (timingSafeEqual(token.hash, hash)) found = token.caller;
    }
    return found;
  }
}
