import { randomUUID } from 'node:crypto';
import { Controller, Get, Inject } from '@nestjs/common';
import type { HealthResponse } from '@app/contracts';
import type { ServiceName } from '@app/shared-types';

export const SERVICE_NAME = Symbol('SERVICE_NAME');

@Controller('health')
export class HealthController {
  private readonly instanceId = randomUUID();

  constructor(@Inject(SERVICE_NAME) private readonly serviceName: ServiceName) {}

  @Get('live')
  live(): HealthResponse {
    return this.snapshot();
  }

  // No external dependencies are wired in this scaffold. Add dependency checks
  // and HTTP 503 here when database/broker connections become required.
  @Get('ready')
  ready(): HealthResponse {
    return this.snapshot();
  }

  private snapshot(): HealthResponse {
    return {
      status: 'UP',
      service: this.serviceName,
      instanceId: this.instanceId,
      checkedAt: new Date().toISOString(),
    };
  }
}
