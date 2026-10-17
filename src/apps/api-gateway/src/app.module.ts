import { Module } from '@nestjs/common';
import { RuntimeModule } from '@app/runtime';
import { AuthVerifierModule } from '@app/auth';
import { ProxyModule } from './proxy/proxy.module';
@Module({
  imports: [RuntimeModule.forRoot('api-gateway'), AuthVerifierModule, ProxyModule],
})
export class AppModule {}
