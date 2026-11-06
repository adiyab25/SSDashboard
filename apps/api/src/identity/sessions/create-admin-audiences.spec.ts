import { MODULE_METADATA } from '@nestjs/common/constants';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IdentityModule } from '../identity.module.js';
import { SESSION_AUDIENCES } from './session-audiences.js';

// `create-admin` runs with no Nest container, so it builds its own `SessionAudiences`. These checks
// tie its choice to the class `IdentityModule` binds, so spec 0008 cannot rebind the module and
// leave the break glass command counting a partner user as staff (spec 0005, AC-28).

const CREATE_ADMIN = fileURLToPath(new URL('../../create-admin.ts', import.meta.url));

/** The class `IdentityModule` binds to `SESSION_AUDIENCES`, from Nest's own module metadata. */
function boundClassName(): string {
  const providers = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, IdentityModule) ??
    []) as unknown[];
  const binding = providers.find(
    (provider): provider is { provide: unknown; useClass?: unknown; useValue?: unknown } =>
      typeof provider === 'object' &&
      provider !== null &&
      (provider as { provide?: unknown }).provide === SESSION_AUDIENCES,
  );
  if (!binding) throw new Error('IdentityModule binds nothing to SESSION_AUDIENCES');
  if (typeof binding.useClass === 'function') return binding.useClass.name;
  const value = binding.useValue as { constructor?: { name?: string } } | undefined;
  if (value?.constructor?.name) return value.constructor.name;
  throw new Error('SESSION_AUDIENCES is bound with neither useClass nor useValue');
}

/** The text of one call in `create-admin.ts`, from its name to the closing `);`. */
function callText(source: string, name: string): string {
  const start = source.indexOf(`${name}(`);
  if (start < 0) throw new Error(`create-admin.ts never calls ${name}`);
  return source.slice(start, source.indexOf(');', start));
}

describe('create-admin asks the same SessionAudiences as IdentityModule (AC-28)', () => {
  const source = readFileSync(CREATE_ADMIN, 'utf8');

  it('builds the class IdentityModule binds to SESSION_AUDIENCES', () => {
    const built = /const audiences = new (\w+)\(/.exec(source)?.[1];

    expect(built).toBe(boundClassName());
  });

  it.each(['createFirstAdmin', 'breakGlassReset'])('passes it to %s', (name) => {
    expect(callText(source, name)).toMatch(/\baudiences\b/);
  });
});
