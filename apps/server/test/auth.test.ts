import { afterAll, describe, expect, it } from 'vitest';
import { createOrganizer, loginCookie, testApp, ORIGIN } from './helpers.js';

const app = await testApp();
// separate app instance: /auth/login is rate-limited 10/min and the main
// suite already spends most of that budget
const app2 = await testApp();
afterAll(async () => {
  await app.close();
  await app2.close();
});

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

describe('change-password', () => {
  const me = (sid: string) =>
    app2.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `sid=${sid}` } });
  const change = (sid: string, payload: unknown) =>
    app2.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { ...ORIGIN, cookie: `sid=${sid}` },
      payload,
    });

  it('changes the password, keeps the current session and revokes others', async () => {
    await createOrganizer('cp@example.com', 'Password123!');
    const first = await loginCookie(app2, 'cp@example.com', 'Password123!');
    const second = await loginCookie(app2, 'cp@example.com', 'Password123!');

    // bootstrap-style account (passwordChangedAt null) → mustChangePassword
    expect((await me(first.sid)).json().organizer.mustChangePassword).toBe(true);

    const res = await change(first.sid, {
      currentPassword: 'Password123!',
      newPassword: 'NewPassword456!',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);

    // current session still works; the flag flipped
    const after = await me(first.sid);
    expect(after.statusCode).toBe(200);
    expect(after.json().organizer.mustChangePassword).toBe(false);

    // the other session was revoked
    expect((await me(second.sid)).statusCode).toBe(401);

    // old password no longer logs in, new one does
    const oldLogin = await app2.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: ORIGIN,
      payload: { email: 'cp@example.com', password: 'Password123!' },
    });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await loginCookie(app2, 'cp@example.com', 'NewPassword456!');
    expect(newLogin.sid).toBeTruthy();
  });

  it('rejects a wrong current password with 401', async () => {
    await createOrganizer('cp2@example.com', 'Password123!');
    const { sid } = await loginCookie(app2, 'cp2@example.com', 'Password123!');
    const res = await change(sid, {
      currentPassword: 'not-the-password',
      newPassword: 'NewPassword456!',
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('Current password is incorrect');
  });

  it('rejects a too-short new password with 400', async () => {
    await createOrganizer('cp3@example.com', 'Password123!');
    const { sid } = await loginCookie(app2, 'cp3@example.com', 'Password123!');
    const res = await change(sid, {
      currentPassword: 'Password123!',
      newPassword: 'short',
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a new password identical to the current one', async () => {
    await createOrganizer('cp4@example.com', 'Password123!');
    const { sid } = await loginCookie(app2, 'cp4@example.com', 'Password123!');
    const res = await change(sid, {
      currentPassword: 'Password123!',
      newPassword: 'Password123!',
    });
    expect(res.statusCode).toBe(400);
  });

  it('requires authentication', async () => {
    const res = await app2.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: ORIGIN,
      payload: { currentPassword: 'x', newPassword: 'NewPassword456!' },
    });
    expect(res.statusCode).toBe(401);
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
