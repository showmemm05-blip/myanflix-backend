import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { Server } from 'node:http';
import { AppModule } from './app.module';

// Node's default is 5 minutes. A single chunk upload can legitimately take
// longer than that on a slow/mobile connection — this only bounds how long
// the server waits on one request, not how much data it accepts.
const REQUEST_TIMEOUT_MS = 15 * 60 * 1000;

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);

  // maxAge (seconds) lets the browser cache a preflight instead of repeating
  // it on every request to the same URL — without it, browsers default to a
  // few seconds at most.
  app.enableCors({ maxAge: 86400 });
  app.setGlobalPrefix('api');
  // Nest defaults to this once @nestjs/platform-socket.io is installed —
  // set explicitly anyway as cheap insurance against that default changing.
  app.useWebSocketAdapter(new IoAdapter(app));
  (app.getHttpServer() as Server).requestTimeout = REQUEST_TIMEOUT_MS;

  const port = configService.get<number>('PORT') ?? 3001;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`MyanFlix API listening on http://localhost:${port}/api`);
}

bootstrap();
