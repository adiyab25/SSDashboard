import { METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { routeCatalog } from '../../../test/route-catalog.js';
import { AppModule } from '../../app.module.js';
import { MeController } from './me.controller.js';
import { PartnerMeController } from './partner-me.controller.js';
import { isWhoAmI, WhoAmI } from './who-am-i.decorator.js';

// Spec 0005 AC-14, security review L3: a temporary password reaches only the handler marked
// `@WhoAmI()`, so the mark must sit on exactly the two GET "who am I" handlers and nowhere else.
/** A handler function read off a class, as Nest hands it to the guard. */
const handlerOf = (target: { prototype: object }, name: string): unknown =>
  Object.getOwnPropertyDescriptor(target.prototype, name)?.value;

const API_SRC = fileURLToPath(new URL('../..', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('the who am I mark (spec 0005 AC-14, security review L3)', () => {
  it.each([
    ['MeController.read', handlerOf(MeController, 'read')],
    ['PartnerMeController.read', handlerOf(PartnerMeController, 'read')],
  ])('marks %s, a GET handler', (_name, handler) => {
    expect(isWhoAmI(handler)).toBe(true);
    expect(Reflect.getMetadata(METHOD_METADATA, handler as object)).toBe(RequestMethod.GET);
  });

  it('marks no other handler, PATCH included', () => {
    expect(isWhoAmI(handlerOf(MeController, 'update'))).toBe(false);
    expect(isWhoAmI(handlerOf(PartnerMeController, 'update'))).toBe(false);
    const users = sourceFiles(API_SRC)
      .filter((path) => /^\s*@WhoAmI\(\)\s*$/m.test(readFileSync(path, 'utf8')))
      .map((path) => relative(API_SRC, path).split(sep).join('/'))
      .sort();

    expect(users).toEqual([
      'identity/sign-in/me.controller.ts',
      'identity/sign-in/partner-me.controller.ts',
    ]);
  });

  it('marks exactly GET /me and GET /partner/me among every handler of the app', () => {
    const marked = routeCatalog(AppModule)
      .filter((route) => isWhoAmI(route.handler))
      .map((route) => `${route.method} ${route.path}`)
      .sort();

    expect(marked).toEqual(['GET /me', 'GET /partner/me']);
  });

  it('reads the mark of the handler itself, never of anything else', () => {
    class Planted {
      @WhoAmI()
      marked(): string {
        return 'me';
      }

      plain(): string {
        return 'other';
      }
    }

    expect(isWhoAmI(handlerOf(Planted, 'marked'))).toBe(true);
    expect(isWhoAmI(handlerOf(Planted, 'plain'))).toBe(false);
    expect(isWhoAmI(undefined)).toBe(false);
    expect(isWhoAmI('/api/me')).toBe(false);
  });
});
