import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/** 默认只监听回环地址：本服务无用户隔离，不允许开箱暴露到局域网或公网。 */
export const DEFAULT_HOST = '127.0.0.1';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const LOOPBACK_ORIGIN = /^https?:\/\/(\[::1\]|localhost|127\.0\.0\.1)(:\d{1,5})?$/i;

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

/** 解析 ALLOWED_ORIGINS（逗号分隔的完整来源），非法项直接丢弃而不是放行。 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => /^https?:\/\/[^/\s]+$/i.test(item));
}

/**
 * 是否允许该来源访问 /api。
 * 不带 Origin（同源导航、curl、服务间调用）与回环来源默认放行；
 * `null` 来自沙箱 iframe / file://，按不可信处理。
 */
export function isAllowedOrigin(origin: string | undefined, extraOrigins: readonly string[]): boolean {
  if (!origin) return true;
  if (origin === 'null') return false;
  return LOOPBACK_ORIGIN.test(origin) || extraOrigins.includes(origin);
}

/**
 * 来源守卫：浏览器跨源请求一律携带 Origin，因此这里同时是 CSRF 防线。
 * 只放行回环来源与显式白名单，拒绝时直接 403，不给任何数据。
 */
export function createOriginGuard(extraOrigins: readonly string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.vary('Origin');
    if (isAllowedOrigin(req.headers.origin, extraOrigins)) {
      next();
      return;
    }
    res.status(403).json({ error: '请求来源不被允许' });
  };
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 令牌优先取 Authorization: Bearer，其次取 X-Access-Token。 */
function readToken(req: Request): string {
  const header = req.get('authorization');
  if (header?.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  return req.get('x-access-token')?.trim() ?? '';
}

/** 未配置令牌时不做校验（仅限回环部署）；配置后所有 /api 请求必须携带同一令牌。 */
export function createTokenGuard(token: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!token || safeEqual(readToken(req), token)) {
      next();
      return;
    }
    res.status(401).json({ error: '需要有效的访问令牌' });
  };
}
