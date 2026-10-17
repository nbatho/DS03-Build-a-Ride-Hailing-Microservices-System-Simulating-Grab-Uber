import { randomUUID } from 'node:crypto';
import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { ServiceName } from '@app/shared-types';
import { HealthController, SERVICE_NAME, INSTANCE_ID } from './health.controller';
import { ReadinessRegistry } from './readiness.registry';
@Module({})
export class RuntimeModule {
  static forRoot(serviceName: ServiceName): DynamicModule {
    return {
      global: true, module: RuntimeModule,
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      controllers: [HealthController],
      providers: [
        { provide: SERVICE_NAME, useValue: serviceName },
        { provide: INSTANCE_ID, useValue: randomUUID() },
        ReadinessRegistry,
      ],
      exports: [ReadinessRegistry, INSTANCE_ID],
    };
  }
}
