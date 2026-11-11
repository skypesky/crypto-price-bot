import { describe, it, expect } from 'vitest';
import {
  HttpError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  InternalError,
} from './errors.js';

describe('HttpError', () => {
  it('构造后保留 status / code / message 并继承 Error', () => {
    const err = new HttpError(418, 'teapot', 'i am a teapot');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.name).toBe('HttpError');
    expect(err.status).toBe(418);
    expect(err.code).toBe('teapot');
    expect(err.message).toBe('i am a teapot');
  });
});

describe('BadRequestError', () => {
  it('默认构造为 400 / bad_request', () => {
    const err = new BadRequestError();
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(400);
    expect(err.code).toBe('bad_request');
    expect(err.message).toBe('bad request');
  });

  it('只传 message 时 code 使用默认值', () => {
    const err = new BadRequestError('参数缺失');
    expect(err.status).toBe(400);
    expect(err.code).toBe('bad_request');
    expect(err.message).toBe('参数缺失');
  });

  it('同时传 message 与 code 时全部使用自定义值', () => {
    const err = new BadRequestError('参数缺失', 'missing_param');
    expect(err.status).toBe(400);
    expect(err.code).toBe('missing_param');
    expect(err.message).toBe('参数缺失');
  });
});

describe('UnauthorizedError', () => {
  it('默认构造为 401 / unauthorized', () => {
    const err = new UnauthorizedError();
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(401);
    expect(err.code).toBe('unauthorized');
    expect(err.message).toBe('unauthorized');
  });

  it('只传 message 时 code 使用默认值', () => {
    const err = new UnauthorizedError('缺少会话');
    expect(err.status).toBe(401);
    expect(err.code).toBe('unauthorized');
    expect(err.message).toBe('缺少会话');
  });

  it('同时传 message 与 code 时全部使用自定义值', () => {
    const err = new UnauthorizedError('缺少会话', 'no_session');
    expect(err.status).toBe(401);
    expect(err.code).toBe('no_session');
    expect(err.message).toBe('缺少会话');
  });
});

describe('ForbiddenError', () => {
  it('默认构造为 403 / forbidden', () => {
    const err = new ForbiddenError();
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(403);
    expect(err.code).toBe('forbidden');
    expect(err.message).toBe('forbidden');
  });

  it('只传 message 时 code 使用默认值', () => {
    const err = new ForbiddenError('无权限');
    expect(err.status).toBe(403);
    expect(err.code).toBe('forbidden');
    expect(err.message).toBe('无权限');
  });

  it('同时传 message 与 code 时全部使用自定义值', () => {
    const err = new ForbiddenError('无权限', 'no_permission');
    expect(err.status).toBe(403);
    expect(err.code).toBe('no_permission');
    expect(err.message).toBe('无权限');
  });
});

describe('NotFoundError', () => {
  it('默认构造为 404 / not_found', () => {
    const err = new NotFoundError();
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(404);
    expect(err.code).toBe('not_found');
    expect(err.message).toBe('not found');
  });

  it('只传 message 时 code 使用默认值', () => {
    const err = new NotFoundError('币种不存在');
    expect(err.status).toBe(404);
    expect(err.code).toBe('not_found');
    expect(err.message).toBe('币种不存在');
  });

  it('同时传 message 与 code 时全部使用自定义值', () => {
    const err = new NotFoundError('币种不存在', 'coin_not_found');
    expect(err.status).toBe(404);
    expect(err.code).toBe('coin_not_found');
    expect(err.message).toBe('币种不存在');
  });
});

describe('ConflictError', () => {
  it('默认构造为 409 / conflict', () => {
    const err = new ConflictError();
    expect(err).toBeInstanceOf(ConflictError);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('conflict');
    expect(err.message).toBe('conflict');
  });

  it('只传 message 时 code 使用默认值', () => {
    const err = new ConflictError('已存在');
    expect(err.status).toBe(409);
    expect(err.code).toBe('conflict');
    expect(err.message).toBe('已存在');
  });

  it('同时传 message 与 code 时全部使用自定义值', () => {
    const err = new ConflictError('已存在', 'duplicated');
    expect(err.status).toBe(409);
    expect(err.code).toBe('duplicated');
    expect(err.message).toBe('已存在');
  });
});

describe('InternalError', () => {
  it('默认构造为 500 / internal_error', () => {
    const err = new InternalError();
    expect(err).toBeInstanceOf(InternalError);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(500);
    expect(err.code).toBe('internal_error');
    expect(err.message).toBe('internal error');
  });

  it('只传 message 时 code 使用默认值', () => {
    const err = new InternalError('数据库异常');
    expect(err.status).toBe(500);
    expect(err.code).toBe('internal_error');
    expect(err.message).toBe('数据库异常');
  });

  it('同时传 message 与 code 时全部使用自定义值', () => {
    const err = new InternalError('数据库异常', 'db_failure');
    expect(err.status).toBe(500);
    expect(err.code).toBe('db_failure');
    expect(err.message).toBe('数据库异常');
  });
});
