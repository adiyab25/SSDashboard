import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from './roles.decorator.js';
import { RolesGuard } from './roles.guard.js';

function setup(required: string[] | undefined, role?: string) {
  const reflector = new Reflector();
  vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) =>
    key === ROLES_KEY ? required : undefined,
  );
  const context = {
    switchToHttp: () => ({ getRequest: () => ({ staff: role ? { role } : undefined }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
  return { guard: new RolesGuard(reflector), context };
}

describe('RolesGuard (AC-15)', () => {
  it('lets any signed in person reach a route with no role limit', () => {
    for (const required of [undefined, []]) {
      const { guard, context } = setup(required, 'staff');
      expect(guard.canActivate(context)).toBe(true);
    }
  });

  it('lets an admin reach an admin route', () => {
    const { guard, context } = setup(['admin'], 'admin');

    expect(guard.canActivate(context)).toBe(true);
  });

  it('answers 403 FORBIDDEN to a staff role on an admin route', () => {
    const { guard, context } = setup(['admin'], 'staff');

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    try {
      guard.canActivate(context);
    } catch (error) {
      expect((error as ForbiddenException).getResponse()).toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('refuses when nobody is on the request, rather than letting it through', () => {
    const { guard, context } = setup(['admin']);

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });
});
