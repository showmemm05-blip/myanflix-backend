import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';
import {
  CLIENT_PLATFORM_HEADER,
  requestHostContext,
  resolveClientPlatform,
} from './common/storage/request-host.context';
import {
  registerBodyParsers,
  signedAccessTokenCheck,
} from './config/body-limits';
import { buildCorsOptions, parseCorsOrigins } from './config/cors.config';
import { trustedClientIp, trustedProxyList } from './config/trusted-proxies';

// Node's default is 5 minutes. A single chunk upload can legitimately take
// longer than that on a slow/mobile connection — this only bounds how long
// the server waits on one request, not how much data it accepts.
const REQUEST_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * The socket.io server with the same browser-origin allowlist as the HTTP
 * API (M-31). RealtimeGateway declares `cors: { origin: '*' }` on its
 * decorator; while CORS_ORIGINS is unset that is exactly what runs, so
 * nothing changes for a machine that has not set it. Once it is set, the
 * allowlist replaces the wildcard here, where the server is created, so the
 * gateway itself stays untouched.
 *
 * What it does, honestly: CORS is a rule BROWSERS apply to fetch/XHR, so it
 * stops a page on an unlisted site from using the polling transport. It
 * does not stop a WebSocket connection — engine.io only adds the headers on
 * an upgrade, it never aborts it — so a page that opens socket.io with
 * `transports: ['websocket']` from an unlisted origin still reaches the
 * handshake. The real gate there is, and always was, the token check in
 * RealtimeGateway.handleConnection; this allowlist is the same courtesy
 * layer the HTTP API gets, not a hard block (that would need engine.io's
 * `allowRequest`, which this round deliberately leaves alone).
 */
class CorsAwareIoAdapter extends IoAdapter {
  constructor(
    app: NestExpressApplication,
    private readonly corsOrigins: string | undefined,
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: Record<string, unknown>) {
    const merged =
      parseCorsOrigins(this.corsOrigins) === null
        ? options
        : { ...options, cors: buildCorsOptions(this.corsOrigins) };
    return super.createIOServer(port, merged) as unknown;
  }
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const configService = app.get(ConfigService);
  const corsOrigins = configService.get<string>('CORS_ORIGINS');

  // 1 MB everywhere, 20 MB only on the transcoder-bundle routes and only
  // for a caller whose access token is genuinely signed by this server
  // (expired is fine: the guard still answers 401 and the admin client
  // refreshes) — a guest never gets the server to read more than 1 MB,
  // whatever path it posts to (M-18).
  const accessTokens = new JwtService({
    secret: configService.get<string>('JWT_SECRET'),
  });
  registerBodyParsers(app, signedAccessTokenCheck(accessTokens));

  // Express's own `req.ip` / `req.protocol` believe X-Forwarded-For only
  // from the proxies listed in TRUSTED_PROXIES — the same rule the context
  // middleware below, the socket gateway and the rate limiter apply
  // (config/trusted-proxies.ts). Empty list = trust nobody, which is right
  // while the API is reached directly; once nginx/HTTPS sits in front, its
  // address goes into TRUSTED_PROXIES (see DOCKER.md) or every user would
  // look like the proxy.
  app.set('trust proxy', trustedProxyList());

  // Per-request context, read back through requestHostContext /
  // requestClientContext:
  //  - `hostname`, so playback and image URLs can be built from the address
  //    the client is already talking to (MinioService.playbackUrl) — the
  //    machine hosting this stack changes networks regularly, and any
  //    hard-coded IP breaks on every hop;
  //  - ip / userAgent / platform, so tracking rows can record where a
  //    request came from without plumbing @Req() through every service.
  //    The ip is a trusted fact (M-5): the socket peer, or the forwarded
  //    client only when that peer is a trusted proxy — never a header the
  //    client typed itself.
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
        ip: trustedClientIp(
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

  // Browser origins allowed to call the API: everyone while CORS_ORIGINS is
  // unset (today's behaviour), only the listed sites once it is set; a
  // request with no Origin header (the apps, curl) is always served. The
  // maxAge lets the browser cache a preflight for a day (config/cors.config.ts).
  app.enableCors(buildCorsOptions(corsOrigins));
  app.setGlobalPrefix('api');
  // Nest defaults to the plain IoAdapter once @nestjs/platform-socket.io is
  // installed — this one also carries the CORS allowlist to socket.io.
  app.useWebSocketAdapter(new CorsAwareIoAdapter(app, corsOrigins));
  app.getHttpServer().requestTimeout = REQUEST_TIMEOUT_MS;

  const port = configService.get<number>('PORT') ?? 3001;
  await app.listen(port);

  console.log(`MyanFlix API listening on http://localhost:${port}/api`);
}

bootstrap();
