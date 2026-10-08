import { JwtService } from '@nestjs/jwt';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import {
  BUNDLE_BODY_PATH,
  bearerTokenOf,
  bearerVerifiedBy,
  registerBodyParsers,
  signedAccessTokenCheck,
  type BundleCallerCheck,
} from './body-limits';

/**
 * M-18: the 20 MB JSON limit is reserved for the transcoder-bundle routes
 * AND for a caller whose bearer token verifies; every other request stops
 * reading at 1 MB. Before the fix a 2 MB login body was read and parsed in
 * full, and a guest could still have 20 MB parsed on a bundle path; now the
 * parser refuses both.
 */
const GOOD = 'Bearer good-token';

function build(
  isBundleCaller: BundleCallerCheck = (req) =>
    req.headers.authorization === GOOD,
) {
  const app = express();
  registerBodyParsers(app, isBundleCaller);
  const echo = (req: Request, res: Response) => {
    res.json({ keys: Object.keys(req.body as object).length });
  };
  app.post('/api/uploads/:movieId/finalize', echo);
  app.post('/api/uploads/:movieId/finalize-replace', echo);
  // Removed from the backend; kept here only to prove its path is back at 1 MB.
  app.post('/api/uploads/:movieId/validate-external', echo);
  app.post('/api/auth/login', echo);
  app.post('/api/uploads/:movieId/reprocess', echo);
  // The same shape AllExceptionsFilter gives a body-parser error.
  app.use(
    (
      err: Error & { statusCode?: number },
      _req: Request,
      res: Response,
      _next: NextFunction,
    ) => {
      res.status(err.statusCode ?? 500).json({ statusCode: err.statusCode });
    },
  );
  return app;
}

/** A JSON object of roughly `kb` kilobytes. */
function jsonOfKb(kb: number): string {
  const files = Array.from({ length: kb * 16 }, (_, i) => ({
    [`f${i}`]: 'x'.repeat(50),
  }));
  return JSON.stringify(Object.assign({}, ...files));
}

describe('registerBodyParsers', () => {
  const app = build();
  const twoMb = jsonOfKb(2048);
  const halfMb = jsonOfKb(512);

  it('names exactly the two bundle routes', () => {
    expect(BUNDLE_BODY_PATH.test('/api/uploads/abc-123/finalize')).toBe(true);
    expect(BUNDLE_BODY_PATH.test('/api/uploads/abc-123/finalize-replace')).toBe(
      true,
    );
    // The unused validate-external route was removed (perf audit
    // 2026-10-07); its path no longer gets the bundle allowance.
    expect(
      BUNDLE_BODY_PATH.test('/api/uploads/abc-123/validate-external'),
    ).toBe(false);
    expect(BUNDLE_BODY_PATH.test('/api/uploads/abc-123/reprocess')).toBe(false);
    expect(BUNDLE_BODY_PATH.test('/api/auth/login')).toBe(false);
    expect(BUNDLE_BODY_PATH.test('/api/uploads/a/b/finalize')).toBe(false);
  });

  it('still accepts a multi-megabyte bundle listing on the finalize routes for a verified caller', async () => {
    for (const path of [
      '/api/uploads/m1/finalize',
      '/api/uploads/m1/finalize-replace',
    ]) {
      const res = await request(app)
        .post(path)
        .set('Authorization', GOOD)
        .set('Content-Type', 'application/json')
        .send(twoMb);
      expect(res.status).toBe(200);
      expect(res.body.keys).toBeGreaterThan(1000);
    }
  });

  it('refuses the same bundle body at 1 MB when the caller has no verified token (guest or forged)', async () => {
    for (const path of [
      '/api/uploads/m1/finalize',
      '/api/uploads/m1/finalize-replace',
    ]) {
      const guest = await request(app)
        .post(path)
        .set('Content-Type', 'application/json')
        .send(twoMb);
      expect(guest.status).toBe(413);
      expect(guest.body).toEqual({ statusCode: 413 });

      const forged = await request(app)
        .post(path)
        .set('Authorization', 'Bearer not-the-good-token')
        .set('Content-Type', 'application/json')
        .send(twoMb);
      expect(forged.status).toBe(413);
    }
  });

  it('the removed validate-external path no longer gets the 20 MB allowance, even for a verified caller', async () => {
    const res = await request(app)
      .post('/api/uploads/m1/validate-external')
      .set('Authorization', GOOD)
      .set('Content-Type', 'application/json')
      .send(twoMb);
    expect(res.status).toBe(413);
  });

  it('a small bundle body still reaches the route without a token (the guard, not the parser, answers)', async () => {
    const res = await request(app)
      .post('/api/uploads/m1/finalize')
      .set('Content-Type', 'application/json')
      .send(halfMb);
    expect(res.status).toBe(200);
    expect(res.body.keys).toBeGreaterThan(1000);
  });

  it('a verified caller is never parsed twice and ordinary routes stay at 1 MB for them too', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Authorization', GOOD)
      .set('Content-Type', 'application/json')
      .send(twoMb);
    expect(res.status).toBe(413);
  });

  it('refuses the same 2 MB body on an ordinary route with 413, before the route runs', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send(twoMb);
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ statusCode: 413 });

    // Another /api/uploads route that is not a bundle route is ordinary too.
    const other = await request(app)
      .post('/api/uploads/m1/reprocess')
      .set('Content-Type', 'application/json')
      .send(twoMb);
    expect(other.status).toBe(413);
  });

  it('keeps ordinary bodies well above the old 100 kb default working (a book chapter)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send(halfMb);
    expect(res.status).toBe(200);
    expect(res.body.keys).toBeGreaterThan(1000);
  });

  it('parses urlencoded bodies with the same 1 MB ceiling', async () => {
    const ok = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('phone=09777000777&password=x');
    expect(ok.status).toBe(200);
    expect(ok.body.keys).toBe(2);

    const big = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(`a=${'x'.repeat(2 * 1024 * 1024)}`);
    expect(big.status).toBe(413);
  });
});

describe('bearerTokenOf', () => {
  const withHeader = (authorization?: string) =>
    ({ headers: { authorization } }) as unknown as Request;

  it('takes exactly "Bearer <token>"', () => {
    expect(bearerTokenOf(withHeader('Bearer abc.def.ghi'))).toBe('abc.def.ghi');
    expect(bearerTokenOf(withHeader('bearer abc'))).toBe('abc');
    expect(bearerTokenOf(withHeader('  Bearer   abc  '))).toBe('abc');
  });

  it('returns null for anything else', () => {
    expect(bearerTokenOf(withHeader())).toBeNull();
    expect(bearerTokenOf(withHeader(''))).toBeNull();
    expect(bearerTokenOf(withHeader('Bearer'))).toBeNull();
    expect(bearerTokenOf(withHeader('Basic abc'))).toBeNull();
    expect(bearerTokenOf(withHeader('Bearer a b'))).toBeNull();
  });
});

describe('bearerVerifiedBy with the real JwtService (what main.ts wires)', () => {
  const secret = 'body-limits-spec-secret-0123456789';
  const check = bearerVerifiedBy((token) =>
    new JwtService({ secret }).verify(token),
  );
  const withToken = (token?: string) =>
    ({
      headers: { authorization: token && `Bearer ${token}` },
    }) as unknown as Request;

  it('passes a token signed with JWT_SECRET', () => {
    const token = new JwtService({ secret }).sign(
      { sub: 'u1' },
      { expiresIn: '15m' },
    );
    expect(check(withToken(token))).toBe(true);
  });

  it('fails with no token, a garbage token, another secret, or an expired token', () => {
    expect(check(withToken())).toBe(false);
    expect(check(withToken('not.a.jwt'))).toBe(false);
    const other = new JwtService({ secret: `${secret}-other` }).sign(
      { sub: 'u1' },
      { expiresIn: '15m' },
    );
    expect(check(withToken(other))).toBe(false);
    const expired = new JwtService({ secret }).sign(
      { sub: 'u1' },
      { expiresIn: '-1s' },
    );
    expect(check(withToken(expired))).toBe(false);
  });

  it('never throws, whatever verify does', () => {
    const boom = bearerVerifiedBy(() => {
      throw new Error('boom');
    });
    expect(boom(withToken('x'))).toBe(false);
  });
});

describe('signedAccessTokenCheck (the check main.ts actually wires)', () => {
  const secret = 'body-limits-spec-secret-0123456789';
  const jwt = new JwtService({ secret });
  const check = signedAccessTokenCheck(jwt);
  const withToken = (token?: string) =>
    ({
      headers: { authorization: token && `Bearer ${token}` },
    }) as unknown as Request;
  const live = jwt.sign({ sub: 'u1' }, { expiresIn: '15m' });
  const expired = jwt.sign({ sub: 'u1' }, { expiresIn: '-1s' });
  const otherSecret = new JwtService({ secret: `${secret}-other` }).sign(
    { sub: 'u1' },
    { expiresIn: '15m' },
  );

  it('passes a live token and an EXPIRED one — both were signed by this server', () => {
    expect(check(withToken(live))).toBe(true);
    expect(check(withToken(expired))).toBe(true);
  });

  it('still fails with no token, garbage, or a token signed with another secret', () => {
    expect(check(withToken())).toBe(false);
    expect(check(withToken('not.a.jwt'))).toBe(false);
    expect(check(withToken(otherSecret))).toBe(false);
  });

  it('a 2 MB finalize listing posted with an expired token reaches the route (so the guard, not the parser, answers)', async () => {
    // The admin client refreshes on a 401 but never on a 413: if the 15-minute
    // token runs out just before a big listing is posted, the parser must not
    // be the one to refuse it. The plain signature+expiry check main.ts wired
    // before gave 413 here; the wired check gives the route a chance.
    const twoMb = jsonOfKb(2048);
    const before = build(bearerVerifiedBy((token) => jwt.verify(token)));
    const staleBefore = await request(before)
      .post('/api/uploads/m1/finalize')
      .set('Authorization', `Bearer ${expired}`)
      .set('Content-Type', 'application/json')
      .send(twoMb);
    expect(staleBefore.status).toBe(413);

    const app = build(check);
    const stale = await request(app)
      .post('/api/uploads/m1/finalize')
      .set('Authorization', `Bearer ${expired}`)
      .set('Content-Type', 'application/json')
      .send(twoMb);
    expect(stale.status).toBe(200);
    expect(stale.body.keys).toBeGreaterThan(1000);

    // A forged token is still refused at 1 MB.
    const forged = await request(app)
      .post('/api/uploads/m1/finalize')
      .set('Authorization', `Bearer ${otherSecret}`)
      .set('Content-Type', 'application/json')
      .send(twoMb);
    expect(forged.status).toBe(413);
  });
});
