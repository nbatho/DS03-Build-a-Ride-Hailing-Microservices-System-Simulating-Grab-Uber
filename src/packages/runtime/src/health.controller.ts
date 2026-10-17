import { randomUUID } from 'node:crypto';
import { Controller, Get, Inject, SetMetadata } from '@nestjs/common';
import type { HealthResponse } from '@app/contracts';
import type { ServiceName } from '@app/shared-types';
import { PUBLIC_ROUTE_METADATA } from '@app/shared-types';
import { ReadinessRegistry } from './readiness.registry';
import { ApiError } from './api-error';
export const SERVICE_NAME = Symbol('SERVICE_NAME');
export const INSTANCE_ID = Symbol('INSTANCE_ID');
@Controller('health')
@SetMetadata(PUBLIC_ROUTE_METADATA, true)
export class HealthController {
  constructor(
    @Inject(SERVICE_NAME) private readonly serviceName: ServiceName,
    @Inject(INSTANCE_ID) private readonly instanceId: string,
    private readonly readiness: ReadinessRegistry,
  ) {}
  @Get('live')
  live(): HealthResponse { return this.snapshot(); }
  @Get('ready')
  async ready(): Promise<HealthResponse> {
    try { await this.readiness.verify(); }
    catch { throw new ApiError(503, 'NOT_READY', 'Required dependencies are not ready'); }
    return this.snapshot();
  }
  private snapshot(): HealthResponse {
    return { status: 'UP', service: this.serviceName, instanceId: this.instanceId, checkedAt: new Date().toISOString() };
  }
}
