import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { PUBLIC_ROUTE_METADATA } from '@app/shared-types';
import type { Actor, UserRole } from '@app/contracts';

export const ROLES_METADATA = 'ds03.roles';
export const Public = () => SetMetadata(PUBLIC_ROUTE_METADATA, true);
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_METADATA, roles);

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Actor =>
    context.switchToHttp().getRequest<{ actor: Actor }>().actor,
);
