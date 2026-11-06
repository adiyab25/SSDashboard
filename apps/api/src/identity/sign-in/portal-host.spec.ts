import { describe, expect, it } from 'vitest';
import { hostnameOf, isPortalRequest, portalHostname } from './portal-host.js';

// Spec 0005, AC-30: Better Auth is reachable on the staff host only.
describe('portal host', () => {
  const portal = portalHostname('https://Shop.Example.com');

  it('knows the portal by host name alone', () => {
    expect(portal).toBe('shop.example.com');
    expect(portalHostname('http://localhost:4000')).toBe('localhost');
    expect(portalHostname('https://shop.example.com.:8443')).toBe('shop.example.com');
    expect(portalHostname('http://[::1]:4000')).toBe('[::1]');
  });

  it.each([
    ['shop.example.com', 'shop.example.com'],
    ['SHOP.Example.com:8443', 'shop.example.com'],
    ['shop.example.com.', 'shop.example.com'],
    ['shop.example.com.:443', 'shop.example.com'],
    [' shop.example.com ', 'shop.example.com'],
    ['[::1]:3001', '[::1]'],
    ['[::1]', '[::1]'],
    ['::1', '::1'],
  ])('reduces %s to the host name %s', (value, expected) => {
    expect(hostnameOf(value)).toBe(expected);
  });

  it('refuses nothing when the install has no portal', () => {
    const none = portalHostname(undefined);

    expect(none).toBeUndefined();
    expect(isPortalRequest({ 'x-forwarded-host': 'shop.example.com' }, none)).toBe(false);
  });

  it.each([
    ['X-Forwarded-Host', { 'x-forwarded-host': 'shop.example.com' }],
    ['X-Forwarded-Host in another letter case', { 'x-forwarded-host': 'SHOP.example.com' }],
    ['X-Forwarded-Host with the default port', { 'x-forwarded-host': 'shop.example.com:443' }],
    ['the portal name on another port', { 'x-forwarded-host': 'shop.example.com:8443' }],
    ['the portal name with a trailing dot', { 'x-forwarded-host': 'shop.example.com.' }],
    ['a trailing dot and a port in Host', { host: 'Shop.Example.com.:8443' }],
    ['any entry of a list', { 'x-forwarded-host': 'erp.example.com, shop.example.com:8443' }],
    ['Host', { host: 'shop.example.com' }],
  ])('spots the portal host in %s', (_case, headers) => {
    expect(isPortalRequest(headers, portal)).toBe(true);
  });

  it('spots a bracketed IPv6 portal on another port', () => {
    expect(isPortalRequest({ host: '[::1]:3001' }, portalHostname('http://[::1]:4000'))).toBe(true);
  });

  it.each([
    ['the staff host', { 'x-forwarded-host': 'erp.example.com', host: 'api:3001' }],
    ['a sibling that only ends like the portal', { 'x-forwarded-host': 'evilshop.example.com' }],
    ['a subdomain of the portal', { 'x-forwarded-host': 'a.shop.example.com' }],
    ['no host header at all', {}],
  ])('lets %s through', (_case, headers) => {
    expect(isPortalRequest(headers, portal)).toBe(false);
  });
});
