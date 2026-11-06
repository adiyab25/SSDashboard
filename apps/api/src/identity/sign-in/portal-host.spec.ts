import { describe, expect, it } from 'vitest';
import { isPortalRequest, portalHosts } from './portal-host.js';

// Spec 0005, AC-30: Better Auth is reachable on the staff host only.
describe('portal host', () => {
  const hosts = portalHosts('https://Shop.Example.com');

  it('knows the portal host with and without its default port', () => {
    expect([...hosts]).toEqual(['shop.example.com', 'shop.example.com:443']);
    expect([...portalHosts('http://localhost:4000')]).toEqual(['localhost:4000']);
  });

  it('refuses nothing when the install has no portal', () => {
    const none = portalHosts(undefined);

    expect(none.size).toBe(0);
    expect(isPortalRequest({ 'x-forwarded-host': 'shop.example.com' }, none)).toBe(false);
  });

  it.each([
    ['X-Forwarded-Host', { 'x-forwarded-host': 'shop.example.com' }],
    ['X-Forwarded-Host in another letter case', { 'x-forwarded-host': 'SHOP.example.com' }],
    ['X-Forwarded-Host with the default port', { 'x-forwarded-host': 'shop.example.com:443' }],
    ['any entry of a list', { 'x-forwarded-host': 'erp.example.com, shop.example.com' }],
    ['Host', { host: 'shop.example.com' }],
  ])('spots the portal host in %s', (_case, headers) => {
    expect(isPortalRequest(headers, hosts)).toBe(true);
  });

  it.each([
    ['the staff host', { 'x-forwarded-host': 'erp.example.com', host: 'api:3001' }],
    ['a sibling that only ends like the portal', { 'x-forwarded-host': 'evilshop.example.com' }],
    ['the portal name on another port', { 'x-forwarded-host': 'shop.example.com:8443' }],
    ['no host header at all', {}],
  ])('lets %s through', (_case, headers) => {
    expect(isPortalRequest(headers, hosts)).toBe(false);
  });
});
