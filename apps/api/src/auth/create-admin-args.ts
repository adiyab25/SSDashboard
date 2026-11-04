import { parseArgs } from 'node:util';

export const CREATE_ADMIN_USAGE = [
  'Usage:',
  '  node dist/create-admin.js --email <email> --name <name>',
  '  node dist/create-admin.js --reset-password --email <email>',
  '  node dist/create-admin.js --reset-two-factor --email <email>',
  '  node dist/create-admin.js --reset-password --reset-two-factor --email <email>',
].join('\n');

export type CreateAdminCommand =
  | { kind: 'create'; email: string; name: string }
  | { kind: 'reset'; email: string; password: boolean; twoFactor: boolean }
  | { kind: 'usage' };

/**
 * Reads the `create-admin` arguments (spec 0005, AC-21, AC-26). `--name` with either reset flag,
 * either reset flag without `--email`, or create without both, is a usage error. Unknown flags
 * and stray positionals are usage errors too.
 */
export function parseCreateAdminArgs(args: string[]): CreateAdminCommand {
  let values: {
    email?: string | undefined;
    name?: string | undefined;
    'reset-password'?: boolean | undefined;
    'reset-two-factor'?: boolean | undefined;
  };
  try {
    ({ values } = parseArgs({
      args,
      options: {
        email: { type: 'string' },
        name: { type: 'string' },
        'reset-password': { type: 'boolean' },
        'reset-two-factor': { type: 'boolean' },
      },
    }));
  } catch {
    return { kind: 'usage' };
  }
  const password = values['reset-password'] === true;
  const twoFactor = values['reset-two-factor'] === true;
  const { email, name } = values;
  if (!email) return { kind: 'usage' };
  if (password || twoFactor) {
    return name === undefined ? { kind: 'reset', email, password, twoFactor } : { kind: 'usage' };
  }
  return name ? { kind: 'create', email, name } : { kind: 'usage' };
}
