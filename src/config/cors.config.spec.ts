import express from 'express';
import request from 'supertest';
import cors from 'cors';
import {
  buildCorsOptions,
  corsOriginProblems,
  isOriginAllowed,
  parseCorsOrigins,
} from './cors.config';

/**
 * M-31 (API part): with CORS_ORIGINS set, only the listed sites get
 * `Access-Control-Allow-Origin`; unset keeps the old wildcard so nothing
 * changes until the owner opts in; a request with no Origin header (the
 * mobile app, curl, the phone-monitor) is always served.
 */
describe('parseCorsOrigins', () => {
  it('treats unset and empty as "no allowlist" (today\'s behaviour)', () => {
    expect(parseCorsOrigins(undefined)).toBeNull();
    expect(parseCorsOrigins('')).toBeNull();
    expect(parseCorsOrigins(' , ,')).toBeNull();
  });

  it('normalises case, whitespace and a trailing slash', () => {
    expect(
      parseCorsOrigins(' https://Admin.Example.com/ , http://localhost:3002'),
    ).toEqual(['https://admin.example.com', 'http://localhost:3002']);
  });
});

describe('corsOriginProblems', () => {
  it('accepts plain http(s) origins and nothing with a path, query, hash or credentials', () => {
    expect(
      corsOriginProblems('https://admin.example.com,http://localhost:3002/'),
    ).toEqual([]);
    expect(
      corsOriginProblems(
        'admin.example.com,https://a.example.com/admin,https://u:p@b.example.com,ftp://c.example.com,https://d.example.com?x=1',
      ),
    ).toEqual([
      'admin.example.com',
      'https://a.example.com/admin',
      'https://u:p@b.example.com',
      'ftp://c.example.com',
      'https://d.example.com?x=1',
    ]);
  });
});

describe('isOriginAllowed', () => {
  const allowed = parseCorsOrigins('https://admin.example.com');

  it('always allows a request with no Origin header', () => {
    expect(isOriginAllowed(undefined, allowed)).toBe(true);
    expect(isOriginAllowed('', allowed)).toBe(true);
  });

  it('allows everything while CORS_ORIGINS is unset', () => {
    expect(isOriginAllowed('http://evil.example', null)).toBe(true);
  });

  it('allows only the listed origins once set', () => {
    expect(isOriginAllowed('https://admin.example.com', allowed)).toBe(true);
    expect(isOriginAllowed('https://ADMIN.example.com/', allowed)).toBe(true);
    expect(isOriginAllowed('http://admin.example.com', allowed)).toBe(false);
    expect(isOriginAllowed('https://admin.example.com:8443', allowed)).toBe(
      false,
    );
    expect(isOriginAllowed('http://evil.example', allowed)).toBe(false);
  });
});

describe('buildCorsOptions through the real cors middleware', () => {
  function appWith(raw: string | undefined) {
    const app = express();
    app.use(cors(buildCorsOptions(raw)));
    app.get('/api/ping', (_req, res) => {
      res.json({ ok: true });
    });
    return app;
  }

  it('unset: the wildcard everyone got before (exactly { maxAge: 86400 })', async () => {
    expect(buildCorsOptions(undefined)).toEqual({ maxAge: 86400 });
    const res = await request(appWith(''))
      .get('/api/ping')
      .set('Origin', 'http://evil.example');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('set: a listed origin is reflected, an unlisted one gets no CORS header', async () => {
    const app = appWith('https://admin.example.com, http://localhost:3002');

    const ok = await request(app)
      .get('/api/ping')
      .set('Origin', 'https://admin.example.com');
    expect(ok.status).toBe(200);
    expect(ok.headers['access-control-allow-origin']).toBe(
      'https://admin.example.com',
    );

    const preflight = await request(app)
      .options('/api/ping')
      .set('Origin', 'http://localhost:3002')
      .set('Access-Control-Request-Method', 'GET');
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(
      'http://localhost:3002',
    );
    expect(preflight.headers['access-control-max-age']).toBe('86400');

    const refused = await request(app)
      .get('/api/ping')
      .set('Origin', 'http://evil.example');
    expect(refused.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('set: a request with no Origin header (mobile app, curl) still gets through', async () => {
    const res = await request(appWith('https://admin.example.com')).get(
      '/api/ping',
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
