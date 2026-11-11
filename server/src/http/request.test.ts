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

  it('读取多段拼接的 body', async () => {
    const req = Readable.from([Buffer.from('a'), Buffer.from('b'), Buffer.from('c')]) as unknown as import('node:http').IncomingMessage;
    expect(await readBody(req)).toBe('abc');
  });

  it('body 超过 1MB 上限时抛出错误', async () => {
    const req = Readable.from([Buffer.alloc(1024 * 1024 + 1, 'a')]) as unknown as import('node:http').IncomingMessage;
    await expect(readBody(req)).rejects.toThrow('request body exceeds 1048576 bytes');
  });

  it('body 恰好等于 1MB 上限时正常返回', async () => {
    const req = Readable.from([Buffer.alloc(1024 * 1024, 'a')]) as unknown as import('node:http').IncomingMessage;
    const text = await readBody(req);
    expect(text.length).toBe(1024 * 1024);
  });

  it('流触发 error 事件时拒绝 Promise', async () => {
    const req = new Readable({
      read() {
        this.destroy(new Error('__test_stream_error'));
      },
    }) as unknown as import('node:http').IncomingMessage;
    await expect(readBody(req)).rejects.toThrow('__test_stream_error');
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

  it('cookie 头为空字符串时返回空对象', () => {
    const req = { headers: { cookie: '' } } as unknown as import('node:http').IncomingMessage;
    expect(parseCookies(req)).toEqual({});
  });

  it('不含等号的片段被跳过', () => {
    const req = { headers: { cookie: 'novalue; a=1' } } as unknown as import('node:http').IncomingMessage;
    expect(parseCookies(req)).toEqual({ a: '1' });
  });

  it('空的 cookie 名被跳过', () => {
    const req = { headers: { cookie: '=orphan; a=1' } } as unknown as import('node:http').IncomingMessage;
    expect(parseCookies(req)).toEqual({ a: '1' });
  });

  it('cookie 名前后空格会被去除', () => {
    const req = { headers: { cookie: '  a  =  1  ' } } as unknown as import('node:http').IncomingMessage;
    expect(parseCookies(req)).toEqual({ a: '1' });
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

  it('url 以问号开头时 pathname 为根路径', () => {
    expect(getPathname('?a=1')).toBe('/');
  });

  it('url 以问号开头时仍能解析 query', () => {
    expect(getQuery('?a=1').get('a')).toBe('1');
  });

  it('空字符串 url 视为根路径', () => {
    expect(getPathname('')).toBe('/');
    expect(getQuery('').toString()).toBe('');
  });

  it('query 中包含多个参数', () => {
    const q = getQuery('/api/x?a=1&b=2&c=3');
    expect(q.get('a')).toBe('1');
    expect(q.get('b')).toBe('2');
    expect(q.get('c')).toBe('3');
  });
});
