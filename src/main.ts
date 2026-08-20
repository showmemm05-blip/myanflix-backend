import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json, urlencoded } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';
import {
  CLIENT_PLATFORM_HEADER,
  requestHostContext,
  resolveClientIp,
  resolveClientPlatform,
} from './common/storage/request-host.context';

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
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const configService = app.get(ConfigService);

  app.use(json({ limit: JSON_BODY_LIMIT }));
  app.use(urlencoded({ extended: true, limit: JSON_BODY_LIMIT }));

  // Every request reaches this API through nginx/the cache server, so the
  // socket's peer address is that proxy, not the user. Trusting the proxy
  // makes Express's own `req.ip`/`req.protocol` reflect the original client
  // via x-forwarded-for (the context middleware below reads the header
  // directly, so it does not depend on this — but anything else that uses
  // req.ip would otherwise silently see the proxy).
  app.set('trust proxy', true);

  // Per-request context, read back through requestHostContext /
  // requestClientContext:
  //  - `hostname`, so playback and image URLs can be built from the address
  //    the client is already talking to (MinioService.playbackUrl) — the
  //    machine hosting this stack changes networks regularly, and any
  //    hard-coded IP breaks on every hop;
  //  - ip / userAgent / platform, so tracking rows can record where a
  //    request came from without plumbing @Req() through every service.
  //
  // Runs UNCONDITIONALLY. It used to skip the ALS entirely when the Host
  // header was empty, which would now silently drop IP and platform capture
  // for those requests. Hostname behaviour is unchanged either way: a
  // missing Host still yields `''`, and every consumer already treats an
  // empty hostname exactly like no context at all (`!ctx?.hostname` falls
  // back to the configured public base).
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const rawHost = req.headers.host ?? '';
    // Strip the API port; keep IPv6 brackets intact.
    const hostname = rawHost.startsWith('[')
      ? rawHost.slice(0, rawHost.indexOf(']') + 1)
      : rawHost.split(':')[0];
    const userAgent = req.headers['user-agent'] ?? null;
    requestHostContext.run(
      {
        hostname,
        ip: resolveClientIp(
          req.headers['x-forwarded-for'],
          req.socket.remoteAddress,
        ),
        userAgent,
        platform: resolveClientPlatform(
          req.headers[CLIENT_PLATFORM_HEADER],
          userAgent,
        ),
      },
      next,
    );
  });

  // maxAge (seconds) lets the browser cache a preflight instead of repeating
  // it on every request to the same URL — without it, browsers default to a
  // few seconds at most.
  app.enableCors({ maxAge: 86400 });
  app.setGlobalPrefix('api');
  // Nest defaults to this once @nestjs/platform-socket.io is installed —
  // set explicitly anyway as cheap insurance against that default changing.
  app.useWebSocketAdapter(new IoAdapter(app));
  app.getHttpServer().requestTimeout = REQUEST_TIMEOUT_MS;

  const port = configService.get<number>('PORT') ?? 3001;
  await app.listen(port);

  console.log(`MyanFlix API listening on http://localhost:${port}/api`);
}

bootstrap();
