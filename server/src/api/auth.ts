import { Router, type Handler, type RouteContext } from '../http/router.js';
import { sendOk, sendError } from '../http/response.js';
import { UnauthorizedError, BadRequestError } from '../http/errors.js';
import { setCookie, clearCookie, getCookie } from '../http/middleware.js';
import { verifyLogin, changePassword as changePwd } from '../core/models/user.js';
import { createSession, findValidSession, deleteSession, deleteUserSessions } from '../core/models/session.js';
import { loginSchema, passwordChangeSchema, parseJson } from '../util/validate.js';

const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds

export function registerAuth(r: Router): void {
  r.post('/api/auth/login', async (ctx) => {
    const parsed = parseJson(loginSchema, ctx.bodyRaw ?? '');
    if (!parsed.ok) throw new BadRequestError(parsed.error);
    const user = await verifyLogin(parsed.data.username, parsed.data.password);
    if (!user) throw new UnauthorizedError('invalid username or password');
    const sess = createSession(user.id);
    setCookie(ctx.res, 'cpb_session', sess.token, {
      maxAge: SESSION_MAX_AGE,
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
    });
    sendOk(ctx.res, { username: user.username });
  });

  r.post('/api/auth/logout', async (ctx) => {
    const token = getCookie(ctx, 'cpb_session');
    if (token) deleteSession(token);
    clearCookie(ctx.res, 'cpb_session');
    sendOk(ctx.res, { ok: true });
  });

  r.post('/api/auth/change-password', async (ctx) => {
    requireAuth(ctx);
    const parsed = parseJson(passwordChangeSchema, ctx.bodyRaw ?? '');
    if (!parsed.ok) throw new BadRequestError(parsed.error);
    const ok = await changePwd(ctx.user!.id, parsed.data.oldPassword, parsed.data.newPassword);
    if (!ok) throw new UnauthorizedError('old password is incorrect');
    // 让其他 session 失效，但保留当前
    // 简化：直接删除该 user 所有 session
    deleteUserSessions(ctx.user!.id);
    sendOk(ctx.res, { ok: true, message: 'password changed; all sessions invalidated, please log in again' });
  });
}

function requireAuth(ctx: RouteContext): void {
  if (!ctx.user) throw new UnauthorizedError('login required');
}

/** 供 server 装配时引用 */
export async function resolveAuthedUser(token: string): Promise<{ id: number; username: string } | null> {
  const sess = findValidSession(token);
  if (!sess) return null;
  const { findById } = await import('../core/models/user.js');
  const user = await findById(sess.user_id);
  if (!user) return null;
  return { id: user.id, username: user.username };
}