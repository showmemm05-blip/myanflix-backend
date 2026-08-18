import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { json, urlencoded } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { Server } from 'node:http';
import { AppModule } from './app.module';
import { requestHostContext } from './common/storage/request-host.context';

// Express's default JSON body limit is 100kb — too small for
// POST /uploads/:movieId/finalize, whose body lists every file in a
// pre-transcoded bundle (every HLS segment across every rendition). A
// multi-hour movie at several renditions can list thousands of paths and
// blow past 100kb even though the payload is just plain text.
const JSON_BODY_LIMIT = '20mb';

// Node's default is 5 minutes. A single chunk upload can legitimately take
// longer than that on a slow/mobile connection — this only bounds how long
// the server waits on one request, not how much data it accepts.
const REQUEST_TIMEOUT_MS = 15 * 60 * 1000;

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);

  app.use(json({ limit: JSON_BODY_LIMIT }));
  app.use(urlencoded({ extended: true, limit: JSON_BODY_LIMIT }));

  // Capture the Host each request came in on so playback URLs can be built
  // from it (MinioService.playbackUrl) — the machine hosting this stack
  // changes networks regularly, and any hard-coded IP breaks on every hop.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const rawHost = req.headers.host ?? '';
    // Strip the API port; keep IPv6 brackets intact.
    const hostname = rawHost.startsWith('[')
      ? rawHost.slice(0, rawHost.indexOf(']') + 1)
      : rawHost.split(':')[0];
    if (!hostname) {
      next();
      return;
    }
    requestHostContext.run({ hostname }, next);
  });

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

  console.log(`MyanFlix API listening on http://localhost:${port}/api`);
}

bootstrap();
