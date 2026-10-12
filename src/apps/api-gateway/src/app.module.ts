import { Module } from '@nestjs/common';
import { RuntimeModule } from '@app/runtime';
import { ProxyModule } from './proxy/proxy.module';

@Module({
  imports: [RuntimeModule.forRoot('api-gateway'), ProxyModule],
})
export class AppModule {}
