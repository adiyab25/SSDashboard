import { describe, expect, it } from 'vitest';
import { clientIp, emailKey, UNKNOWN_IP, userAgent } from './client-info.js';

describe('clientIp', () => {
  it('takes the first X-Forwarded-For value', () => {
    expect(clientIp(new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.2' }))).toBe(
      '203.0.113.7',
    );
  });

  it('falls back when there is no header, and never returns the all addresses scope', () => {
    expect(clientIp(new Headers())).toBe(UNKNOWN_IP);
    expect(clientIp(undefined)).toBe(UNKNOWN_IP);
    expect(clientIp(new Headers({ 'x-forwarded-for': '*' }))).toBe(UNKNOWN_IP);
  });
});

describe('emailKey', () => {
  it('trims and lowercases, so letter case and padding cannot dodge a lock', () => {
    expect(emailKey('  Sam@Example.COM ')).toBe('sam@example.com');
  });

  it('caps the length so a huge value cannot bloat the table', () => {
    expect(emailKey('a'.repeat(5000))).toHaveLength(320);
  });
});

describe('userAgent', () => {
  it('returns null when absent and caps a long value', () => {
    expect(userAgent(new Headers())).toBeNull();
    expect(userAgent(new Headers({ 'user-agent': 'x'.repeat(900) }))).toHaveLength(300);
  });
});
