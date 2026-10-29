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

/** 公开部署的显式声明：反向代理后 HOST 仍可能是回环地址，不能据此免除认证。 */
export function parsePublicDeployment(raw: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(raw?.trim() ?? '');
}

/**
 * 启动前的认证准入检查：返回 null 表示可以启动，否则返回拒绝原因。
 * 回环监听且未声明公开部署时才允许无令牌运行。
 */
export function deploymentAuthError(
  host: string,
  accessToken: string,
  publicDeployment: boolean,
): string | null {
  if (accessToken.trim()) return null;
  if (!publicDeployment && isLoopbackHost(host)) return null;
  const reason = publicDeployment
    ? '已声明公开部署（PUBLIC_DEPLOYMENT），但未设置 ACCESS_TOKEN；反向代理后 HOST 仍可能是回环地址，不能作为免认证的依据'
    : `HOST=${host} 会暴露到本机之外，但未设置 ACCESS_TOKEN`;
  return [
    `拒绝启动：${reason}。`,
    '本服务没有用户隔离（组合、观察仓与全部写接口共用一份数据），',
    '因此不允许无认证对外提供服务。请设置 ACCESS_TOKEN=... 后重试；',
    '多人使用请按人一实例部署，切勿共享同一数据目录。',
  ].join('\n');
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
