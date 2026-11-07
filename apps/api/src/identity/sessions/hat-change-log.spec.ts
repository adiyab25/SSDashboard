import { Logger } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HatsChanged } from '../../platform/events/auth-events.js';
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

  it('adds the before and after holdings and the reason when given (spec 0008, AC-13)', () => {
    const line = hatChangeLogLine(context, ['support'], ['support'], {
      before: { hats: ['support'], costView: false, partnerAccountId: null },
      after: { hats: ['support', 'support'], costView: true, partnerAccountId: null },
      reason: 'Needs margins for the monthly report',
    });

    // A cost only change: no hat moved, and the line still says what changed.
    expect(line).toMatchObject({
      hatsAdded: [],
      hatsRemoved: [],
      before: { hats: ['support'], costView: false, partnerAccountId: null },
      after: { hats: ['support'], costView: true, partnerAccountId: null },
      reason: 'Needs margins for the monthly report',
    });
  });

  it('copies only the named fields of a holding, so a wider object adds nothing', () => {
    const wide = {
      hats: ['partner'],
      costView: false,
      partnerAccountId: 'p1',
      email: 'someone@example.com',
    };

    const line = hatChangeLogLine(context, [], ['partner'], { after: wide });

    expect(line.after).toEqual({ hats: ['partner'], costView: false, partnerAccountId: 'p1' });
  });
});

describe('AuthAudit.hatsChanged', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes the line as one JSON log entry and emits no event when none is given', () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const emit = vi.fn();
    const audit = new AuthAudit({ emit } as unknown as EventEmitter2);
    const line = hatChangeLogLine(context, ['warehouse'], ['support']);

    audit.hatsChanged(line);

    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toEqual(line);
    expect(emit).not.toHaveBeenCalled();
  });

  it('writes only the named fields, never the rest of a wider object', () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const audit = new AuthAudit({ emit: vi.fn() } as unknown as EventEmitter2);
    const line = hatChangeLogLine(context, ['warehouse'], ['support'], {
      before: { hats: ['warehouse'], costView: false, partnerAccountId: null },
      after: { hats: ['support'], costView: false, partnerAccountId: null },
      reason: 'Moved to the support desk',
    });
    const wider = {
      ...line,
      email: 'someone@example.com',
      after: { ...line.after, phone: '+201000000000' },
    } as typeof line;

    audit.hatsChanged(wider);

    expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toEqual(line);
  });

  it('emits the HatsChanged event it is given, once, after the line', () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const emit = vi.fn();
    const audit = new AuthAudit({ emit } as unknown as EventEmitter2);
    const holding = { hats: ['support' as const], costView: false, partnerAccountId: null };
    const event = new HatsChanged(context, { ...holding, hats: ['warehouse'] }, holding, null);

    audit.hatsChanged(hatChangeLogLine(context, ['warehouse'], ['support']), event);

    expect(log).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledExactlyOnceWith('HatsChanged', event);
  });

  it('never throws when a HatsChanged listener does: the change has already committed', () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const emit = vi.fn(() => {
      throw new Error('listener broke');
    });
    const audit = new AuthAudit({ emit } as unknown as EventEmitter2);
    const holding = { hats: ['support' as const], costView: false, partnerAccountId: null };

    expect(() =>
      audit.hatsChanged(
        hatChangeLogLine(context, ['support'], ['support']),
        new HatsChanged(context, holding, { ...holding, costView: true }, null),
      ),
    ).not.toThrow();
    expect(error).toHaveBeenCalledTimes(1);
  });
});
