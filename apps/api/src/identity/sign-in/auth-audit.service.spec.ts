import { Logger } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PartnerUserDisabled,
  SignInFailed,
  StaffDisabled,
  type AuthEventContext,
} from '../../platform/events/auth-events.js';
import { AuthAudit } from './auth-audit.service.js';

const context: AuthEventContext = {
  actorId: 'actor-1',
  targetId: 'target-1',
  ip: '203.0.113.7',
  userAgent: null,
  at: new Date('2026-11-07T10:00:00Z'),
};

function lineOf(event: Parameters<AuthAudit['record']>[0]): Record<string, unknown> {
  const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  new AuthAudit({ emit: vi.fn() } as unknown as EventEmitter2).record(event);
  const line = JSON.parse(String(log.mock.calls[0]?.[0])) as Record<string, unknown>;
  log.mockRestore();
  return line;
}

afterEach(() => vi.restoreAllMocks());

describe('AuthAudit.record reason on the log line', () => {
  it('keeps the code of a sign in failure readable', () => {
    expect(lineOf(new SignInFailed(context, 'bad_credentials')).reason).toBe('bad_credentials');
  });

  it.each([
    ['StaffDisabled', (reason: string | null) => new StaffDisabled(context, reason)],
    ['PartnerUserDisabled', (reason: string | null) => new PartnerUserDisabled(context, reason)],
  ])('hides the free text reason of %s and keeps null as null', (_name, make) => {
    const written = lineOf(make('Call me on 01012345678'));
    expect(written.reason).toBe('[REDACTED]');
    expect(JSON.stringify(written)).not.toContain('01012345678');
    expect(lineOf(make(null)).reason).toBeNull();
  });
});
