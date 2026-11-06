import type { IncomingHttpHeaders } from 'node:http';

/**
 * The host name in a `Host` style value (`name`, `name:port`, `[v6]` or `[v6]:port`): lowercased,
 * without the port and without trailing dots. Cookies are scoped by host name and ignore the
 * port, so a refusal by host name is the one that matches what the browser would send the staff
 * cookie to (security review 3). An unbracketed value with several colons (a bare IPv6 address)
 * is kept whole. Never use the result to admit a request: it only feeds a refusal.
 */
export function hostnameOf(host: string): string {
  const value = host.trim().toLowerCase();
  let name = value;
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    name = end === -1 ? value : value.slice(0, end + 1);
  } else if (value.split(':').length === 2) {
    name = value.slice(0, value.indexOf(':'));
  }
  return name.replace(/\.+$/, '');
}

/**
 * The portal's host name, normalized like every request candidate (`shop.example.com` for
 * `https://Shop.Example.com.:8443`), or undefined when the install has no portal
 * (`PORTAL_ORIGIN` unset), so nothing is ever refused.
 */
export function portalHostname(portalOrigin: string | undefined): string | undefined {
  if (!portalOrigin) return undefined;
  return hostnameOf(new URL(portalOrigin).host);
}

const valuesOf = (header: string | string[] | undefined): string[] =>
  (Array.isArray(header) ? header : [header ?? ''])
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);

/**
 * True when a request reached the api through the portal host (spec 0005, AC-30). The spec
 * reads the host the browser asked for from `X-Forwarded-Host` (marked Assumed there, since
 * `deploy/Caddyfile` does not set that header explicitly), so `Host` is checked as well, and any
 * entry of a comma separated list counts. Every candidate is compared by host name, so the portal
 * name on another port or with a trailing dot is refused too: a refusal is never wrong here,
 * because Better Auth has no business on the portal host. Never use it to admit a request: it
 * only ever refuses.
 */
export function isPortalRequest(headers: IncomingHttpHeaders, portal: string | undefined): boolean {
  if (portal === undefined) return false;
  return [...valuesOf(headers['x-forwarded-host']), ...valuesOf(headers.host)].some(
    (host) => hostnameOf(host) === portal,
  );
}
