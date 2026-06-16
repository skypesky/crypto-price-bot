import { describe, it, expect } from 'vitest';
import { readBody, parseCookies, getPathname, getQuery } from './request.js';
import { Readable } from 'node:stream';

function mockReq(body: string): import('node:http').IncomingMessage {
  const req = Readable.from([Buffer.from(body, 'utf8')]) as unknown as import('node:http').IncomingMessage;
  return req;
}

describe('readBody', () => {
  it('读取 body', async () => {
    const text = await readBody(mockReq('hello'));
    expect(text).toBe('hello');
  });

  it('空 body', async () => {
    expect(await readBody(mockReq(''))).toBe('');
  });
});

describe('parseCookies', () => {
  it('解析多个 cookie', () => {
    const req = { headers: { cookie: 'a=1; b=hello%20world; c=' } } as unknown as import('node:http').IncomingMessage;
    expect(parseCookies(req)).toEqual({ a: '1', b: 'hello world', c: '' });
  });

  it('无 cookie 返回空对象', () => {
    const req = { headers: {} } as unknown as import('node:http').IncomingMessage;
    expect(parseCookies(req)).toEqual({});
  });
});

describe('getPathname / getQuery', () => {
  it('拆分 url', () => {
    expect(getPathname('/api/x?a=1')).toBe('/api/x');
    expect(getQuery('/api/x?a=1&b=2').get('a')).toBe('1');
  });

  it('无 query', () => {
    expect(getPathname('/api/x')).toBe('/api/x');
    expect(getQuery('/api/x').toString()).toBe('');
  });

  it('undefined url', () => {
    expect(getPathname(undefined)).toBe('/');
    expect(getQuery(undefined).toString()).toBe('');
  });
});