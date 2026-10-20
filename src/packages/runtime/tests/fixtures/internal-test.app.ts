import { Controller, Get, Module, RequestMethod, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AuthVerifierModule } from '@app/auth';
import type { InternalCaller } from '@app/shared-types';
import { ApiExceptionFilter, CurrentCaller, InternalRoute, RuntimeModule } from '@app/runtime';

@InternalRoute('TRIP')
@Controller('internal/v1/quotes')
class QuotesInternalController {
  @Get('ping')
  ping(@CurrentCaller() caller: InternalCaller) { return { caller }; }

  // Khai ở method thì ghi đè danh sách của class.
  @InternalRoute('MATCHING', 'TRIP')
  @Get('shared')
  shared(@CurrentCaller() caller: InternalCaller) { return { caller }; }
}

@Controller('internal/v1/forgotten')
class ForgottenInternalController {
  @Get()
  open() { return { leaked: true }; }
}

@Module({
  imports: [RuntimeModule.forRoot('pricing-service'), AuthVerifierModule],
  controllers: [QuotesInternalController, ForgottenInternalController],
})
class InternalTestModule {}

/** Dựng app giống bootstrap(): tiền tố public api/v1, đường /internal/v1 không có tiền tố. */
export async function createInternalTestApp(): Promise<{ app: INestApplication; url: string }> {
  const app = await NestFactory.create(InternalTestModule, { logger: false });
  app.setGlobalPrefix('api/v1', { exclude: [{ path: 'internal/v1/{*path}', method: RequestMethod.ALL }] });
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.listen(0, '127.0.0.1');
  return { app, url: (await app.getUrl()).replace('[::1]', '127.0.0.1') };
}
