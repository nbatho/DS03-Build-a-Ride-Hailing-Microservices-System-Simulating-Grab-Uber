import 'reflect-metadata';
import { Logger, RequestMethod, Type, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SERVICE_CONFIG, ServiceName } from '@app/shared-types';

export async function bootstrap(appModule: Type<unknown>, serviceName: ServiceName): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(appModule, { bodyParser: false });
  try {
    const config = app.get(ConfigService);
    const service = SERVICE_CONFIG[serviceName];
    const rawPort = String(config.get<string>(service.portEnv) ?? service.defaultPort);
    const port = Number(rawPort);
    if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(service.portEnv + ' must be an integer between 1 and 65535');
    }

    app.useBodyParser('json', { limit: '64kb' });
    app.setGlobalPrefix('api/v1', {
      exclude: [
        { path: 'health/live', method: RequestMethod.GET },
        { path: 'health/ready', method: RequestMethod.GET },
      ],
    });
    app.useGlobalPipes(new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }));
    app.enableShutdownHooks();
    await app.listen(port, config.get<string>('HOST') ?? '127.0.0.1');
    Logger.log(serviceName + ' listening at ' + await app.getUrl(), 'Bootstrap');
  } catch (error) {
    await app.close();
    throw error;
  }
}
