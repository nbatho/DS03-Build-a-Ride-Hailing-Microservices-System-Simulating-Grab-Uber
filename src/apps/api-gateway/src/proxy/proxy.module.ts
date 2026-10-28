import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { ProxyController } from './proxy.controller';
import { ProxyService } from './proxy.service';
import { RateLimitMiddleware } from './rate-limit';

@Module({
  controllers: [ProxyController],
  providers: [ProxyService],
})
export class ProxyModule implements NestModule {
  // Route bắt-tất-cả khiến middleware chạy cả cho /health/*; RateLimitMiddleware tự bỏ qua đường ngoài /api/v1/.
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RateLimitMiddleware).forRoutes(ProxyController);
  }
}
