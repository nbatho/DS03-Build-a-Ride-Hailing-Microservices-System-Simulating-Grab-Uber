import { CanActivate, ExecutionContext, HttpException, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { isUUID } from 'class-validator';
import type { Request } from 'express';
import { USER_ROLES, type Actor, type UserRole } from '@app/contracts';
import { PUBLIC_ROUTE_METADATA } from '@app/shared-types';
import { ROLES_METADATA } from './decorators';
import type { VerifierOptions } from './key-config';

export const JWT_VERIFIER_OPTIONS = Symbol('JWT_VERIFIER_OPTIONS');

function deny(status: number, code: string): never {
  throw new HttpException(
    { code, message: status === 401 ? 'Invalid or missing access token' : 'Role is not permitted' },
    status,
  );
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
    @Inject(JWT_VERIFIER_OPTIONS) private readonly options: VerifierOptions,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (
      this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE_METADATA, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return true;
    }

    const req = context.switchToHttp().getRequest<Request & { actor?: Actor }>();
    const authorization = req.headers.authorization;
    const match =
      typeof authorization === 'string' ? /^Bearer ([^\s]+)$/i.exec(authorization) : null;

    if (!match) {
      deny(401, 'INVALID_TOKEN');
    }

    try {
      const payload = await this.jwt.verifyAsync<Record<string, unknown>>(match[1], {
        publicKey: this.options.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        algorithms: ['RS256'],
        issuer: this.options.issuer,
        audience: this.options.audience,
      });

      if (
        typeof payload.sub !== 'string' ||
        !isUUID(payload.sub) ||
        typeof payload.exp !== 'number' ||
        !Number.isInteger(payload.exp) ||
        typeof payload.role !== 'string' ||
        !USER_ROLES.includes(payload.role as UserRole)
      ) {
        deny(401, 'INVALID_TOKEN');
      }

      req.actor = { userId: payload.sub, role: payload.role as UserRole };

      return true;
    } catch {
      deny(401, 'INVALID_TOKEN');
    }
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (
      this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE_METADATA, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return true;
    }

    const roles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!roles) {
      return true;
    }

    const actor = context.switchToHttp().getRequest<{ actor?: Actor }>().actor;

    if (!actor) {
      deny(401, 'INVALID_TOKEN');
    }

    if (!roles.includes(actor.role)) {
      deny(403, 'ROLE_FORBIDDEN');
    }

    return true;
  }
}
