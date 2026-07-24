import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { Server } from 'node:http';
import { AppModule } from './app.module';

// Node's default is 5 minutes. A single chunk upload can legitimately take
// longer than that on a slow/mobile connection — this only bounds how long
// the server waits on one request, not how much data it accepts.
const REQUEST_TIMEOUT_MS = 15 * 60 * 1000;

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);

  app.enableCors();
  app.setGlobalPrefix('api');
  (app.getHttpServer() as Server).requestTimeout = REQUEST_TIMEOUT_MS;

  const port = configService.get<number>('PORT') ?? 3001;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`MyanFlix API listening on http://localhost:${port}/api`);
}

bootstrap();
