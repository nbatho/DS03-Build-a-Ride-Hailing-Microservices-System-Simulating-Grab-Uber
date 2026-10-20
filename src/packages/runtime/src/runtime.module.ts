import { randomUUID } from 'node:crypto';
import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { SERVICE_CALLER_NAME, type ServiceName } from '@app/shared-types';
import { HealthController, SERVICE_NAME, INSTANCE_ID } from './health.controller';
import { ReadinessRegistry } from './readiness.registry';
import { INBOUND_SERVICE_TOKENS, InternalCallerGuard, loadInboundTokens } from './internal-auth';
import { InternalHttpClient } from './internal-http.client';
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
        {
          provide: INBOUND_SERVICE_TOKENS,
          inject: [ConfigService],
          // ConfigService được inject để chắc .env đã nạp vào process.env; token sai định dạng thì dừng khi khởi động.
          useFactory: (_config: ConfigService) => loadInboundTokens(process.env, SERVICE_CALLER_NAME[serviceName]),
        },
        { provide: APP_GUARD, useClass: InternalCallerGuard },
        InternalHttpClient,
      ],
      exports: [ReadinessRegistry, INSTANCE_ID, InternalHttpClient],
    };
  }
}
