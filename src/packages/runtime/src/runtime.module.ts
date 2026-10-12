import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { ServiceName } from '@app/shared-types';
import { HealthController, SERVICE_NAME } from './health.controller';

@Module({})
export class RuntimeModule {
  static forRoot(serviceName: ServiceName): DynamicModule {
    return {
      module: RuntimeModule,
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      controllers: [HealthController],
      providers: [{ provide: SERVICE_NAME, useValue: serviceName }],
    };
  }
}
