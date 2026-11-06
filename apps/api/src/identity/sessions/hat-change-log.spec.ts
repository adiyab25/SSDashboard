import { Logger } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthAudit } from '../sign-in/auth-audit.service.js';
import { hatChangeLogLine } from './hat-change-log.js';

const context = {
  actorId: '0190c0de-0000-7000-8000-000000000001',
  targetId: '0190c0de-0000-7000-8000-000000000002',
  ip: '203.0.113.7',
  userAgent: 'Firefox',
  at: new Date('2026-11-06T10:00:00.000Z'),
};

describe('hatChangeLogLine (spec 0005, AC-33 e)', () => {
  it('names the actor, target, address, agent, time and the hats added and removed', () => {
    expect(
      hatChangeLogLine(context, ['warehouse', 'support'], ['support', 'manager', 'buyer']),
    ).toEqual({
      event: 'HatsChanged',
      actorId: context.actorId,
      targetId: context.targetId,
      ip: '203.0.113.7',
      userAgent: 'Firefox',
      at: '2026-11-06T10:00:00.000Z',
      hatsAdded: ['buyer', 'manager'],
      hatsRemoved: ['warehouse'],
    });
  });

  it('logs nothing as both added and removed, and an unchanged set as no change', () => {
    const line = hatChangeLogLine(context, ['support', 'support'], ['support']);

    expect(line.hatsAdded).toEqual([]);
    expect(line.hatsRemoved).toEqual([]);
  });

  it('holds only the AC-23 fields and the two hat lists', () => {
    expect(Object.keys(hatChangeLogLine(context, [], ['support'])).sort()).toEqual([
      'actorId',
      'at',
      'event',
      'hatsAdded',
      'hatsRemoved',
      'ip',
      'targetId',
      'userAgent',
    ]);
  });
});

describe('AuthAudit.hatsChanged', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes the line as one JSON log entry and emits no event', () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const emit = vi.fn();
    const audit = new AuthAudit({ emit } as unknown as EventEmitter2);
    const line = hatChangeLogLine(context, ['warehouse'], ['support']);

    audit.hatsChanged(line);

    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toEqual(line);
    expect(emit).not.toHaveBeenCalled();
  });
});
