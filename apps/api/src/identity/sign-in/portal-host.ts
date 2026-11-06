import type { IncomingHttpHeaders } from 'node:http';

/**
 * The `host` values that name the portal, lowercased: the origin's host, and with the scheme's
 * default port spelled out too (`shop.example.com` and `shop.example.com:443`). Empty when the
 * install has no portal (`PORTAL_ORIGIN` unset), so nothing is ever refused.
 */
export function portalHosts(portalOrigin: string | undefined): ReadonlySet<string> {
  if (!portalOrigin) return new Set();
  const url = new URL(portalOrigin);
  const hosts = new Set([url.host.toLowerCase()]);
  if (url.port === '') {
    hosts.add(`${url.hostname.toLowerCase()}:${url.protocol === 'https:' ? '443' : '80'}`);
  }
  return hosts;
}

const valuesOf = (header: string | string[] | undefined): string[] =>
  (Array.isArray(header) ? header : [header ?? ''])
    .flatMap((value) => value.split(','))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

/**
 * True when a request reached the api through the portal host (spec 0005, AC-30). The spec
 * reads the host the browser asked for from `X-Forwarded-Host` (marked Assumed there, since
 * `deploy/Caddyfile` sets no host header itself), so `Host` is checked as well, and any entry of
 * a comma separated list counts: a refusal is never wrong here, because Better Auth has no
 * business on the portal host. Never use it to admit a request: it only ever refuses.
 */
export function isPortalRequest(headers: IncomingHttpHeaders, hosts: ReadonlySet<string>): boolean {
  if (hosts.size === 0) return false;
  return [...valuesOf(headers['x-forwarded-host']), ...valuesOf(headers.host)].some((host) =>
    hosts.has(host),
  );
}
