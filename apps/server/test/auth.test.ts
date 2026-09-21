import { afterAll, describe, expect, it } from 'vitest';
import { createOrganizer, loginCookie, testApp, ORIGIN } from './helpers.js';

const app = await testApp();
afterAll(() => app.close());

describe('auth', () => {
  it('rejects wrong password with a generic 401', async () => {
    await createOrganizer('a@example.com', 'Password123!');
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: ORIGIN,
      payload: { email: 'a@example.com', password: 'wrong-password' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('Invalid email or password');
    expect(res.cookies.find((c) => c.name === 'sid')).toBeUndefined();
  });

  it('login sets an httpOnly sid cookie and /me returns the organizer', async () => {
    await createOrganizer('b@example.com', 'Password123!');
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: ORIGIN,
      payload: { email: 'b@example.com', password: 'Password123!' },
    });
    expect(res.statusCode).toBe(200);
    const sid = res.cookies.find((c) => c.name === 'sid');
    expect(sid).toBeDefined();
    expect(sid!.httpOnly).toBe(true);
    expect(sid!.sameSite).toBe('Lax');

    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: `sid=${sid!.value}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().organizer.email).toBe('b@example.com');
  });

  it('/me without cookie → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('logout invalidates the session', async () => {
    await createOrganizer('c@example.com', 'Password123!');
    const cookies = await loginCookie(app, 'c@example.com', 'Password123!');
    const out = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { ...ORIGIN, cookie: `sid=${cookies.sid}` },
    });
    expect(out.statusCode).toBe(200);
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: `sid=${cookies.sid}` },
    });
    expect(me.statusCode).toBe(401);
  });
});

describe('origin guard', () => {
  it('mutating request without Origin → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'x@example.com', password: 'x' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('mutating request with a foreign Origin → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'https://evil.example' },
      payload: { email: 'x@example.com', password: 'x' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('same-origin request passes the guard', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: ORIGIN,
      payload: { email: 'nobody@example.com', password: 'x' },
    });
    // past CSRF — fails auth instead
    expect(res.statusCode).toBe(401);
  });
});
