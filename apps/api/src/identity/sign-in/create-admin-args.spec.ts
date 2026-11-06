import { describe, expect, it } from 'vitest';
import { CREATE_ADMIN_USAGE, parseCreateAdminArgs } from './create-admin-args.js';

const E = 'owner@example.com';

// Spec 0005, AC-21, AC-26: the create-admin command line.
describe('parseCreateAdminArgs', () => {
  it('reads create mode', () => {
    expect(parseCreateAdminArgs(['--email', E, '--name', 'Owner'])).toEqual({
      kind: 'create',
      email: E,
      name: 'Owner',
    });
  });

  it('reads each reset mode and both together', () => {
    expect(parseCreateAdminArgs(['--reset-password', '--email', E])).toEqual({
      kind: 'reset',
      email: E,
      password: true,
      twoFactor: false,
    });
    expect(parseCreateAdminArgs(['--reset-two-factor', '--email', E])).toEqual({
      kind: 'reset',
      email: E,
      password: false,
      twoFactor: true,
    });
    expect(parseCreateAdminArgs(['--reset-two-factor', '--email', E, '--reset-password'])).toEqual({
      kind: 'reset',
      email: E,
      password: true,
      twoFactor: true,
    });
  });

  it.each([
    [[]],
    [['--email', E]],
    [['--name', 'Owner']],
    [['--reset-password']],
    [['--reset-two-factor']],
    [['--reset-password', '--reset-two-factor']],
    [['--reset-password', '--email', E, '--name', 'Owner']],
    [['--reset-two-factor', '--email', E, '--name', 'Owner']],
    [['--reset-password', '--reset-two-factor', '--email', E, '--name', 'Owner']],
    [['--reset-two-factor', '--email', E, '--unknown']],
    [['--reset-two-factor', '--email', E, 'stray']],
    [['--email', '', '--reset-two-factor']],
  ])('answers usage for %j', (args) => {
    expect(parseCreateAdminArgs(args)).toEqual({ kind: 'usage' });
  });

  it('lists every form in the usage text', () => {
    expect(CREATE_ADMIN_USAGE).toContain('--email <email> --name <name>');
    expect(CREATE_ADMIN_USAGE).toContain('--reset-password --email <email>');
    expect(CREATE_ADMIN_USAGE).toContain('--reset-two-factor --email <email>');
  });
});
