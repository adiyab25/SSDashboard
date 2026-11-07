import { HttpException, type ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { Audience, type AudienceName } from '../audience/audience.decorator.js';
import { Access } from './access.js';
import { AnyHat, Permission } from './permission.decorator.js';
import { PermissionGuard } from './permission.guard.js';

const USER = '0190c0de-0000-7000-8000-000000000001';

function context(
  audience: AudienceName,
  decorate: { handler?: Array<MethodDecorator>; controller?: Array<ClassDecorator> },
  access?: unknown,
): ExecutionContext {
  class Probe {
    handle(): void {}
  }
  Audience(audience)(Probe);
  for (const decorator of decorate.controller ?? []) decorator(Probe);
  const descriptor = Object.getOwnPropertyDescriptor(Probe.prototype, 'handle');
  for (const decorator of decorate.handler ?? []) decorator(Probe.prototype, 'handle', descriptor!);
  const handler: unknown = descriptor?.value;
  return {
    getClass: () => Probe,
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => ({ access }) }),
  } as unknown as ExecutionContext;
}

const accessOf = (hats: string[], grants: string[] = []) =>
  new Access({ userId: USER, hats, grants, partnerAccountId: null });

/** The body of the HTTP error a guard call throws; fails the test when it throws none. */
function answerOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    if (error instanceof HttpException)
      return { status: error.getStatus(), body: error.getResponse() };
    throw error;
  }
  throw new Error('expected an HTTP error');
}

describe('PermissionGuard (spec 0008, AC-4)', () => {
  const guard = new PermissionGuard();

  it('answers 500 PERMISSION_MISSING for a staff route with no declaration', () => {
    expect(
      answerOf(() => guard.canActivate(context('staff', {}, accessOf(['manager'])))),
    ).toMatchObject({
      status: 500,
      body: { code: 'PERMISSION_MISSING' },
    });
  });

  it('answers 500 PERMISSION_MISSING for two declarations on one handler', () => {
    const ctx = context(
      'staff',
      { handler: [Permission('stock.view'), AnyHat()] },
      accessOf(['manager']),
    );

    expect(answerOf(() => guard.canActivate(ctx))).toMatchObject({
      status: 500,
      body: { code: 'PERMISSION_MISSING' },
    });
  });

  it('answers 403 FORBIDDEN, naming no permission, when the caller lacks one', () => {
    const ctx = context(
      'staff',
      { handler: [Permission('people.manage')] },
      accessOf(['warehouse']),
    );

    expect(answerOf(() => guard.canActivate(ctx))).toEqual({
      status: 403,
      body: { code: 'FORBIDDEN', message: 'You do not have access to this.' },
    });
  });

  it('needs every listed permission', () => {
    const needsBoth = { handler: [Permission('stock.view', 'cost.view')] };

    expect(() => guard.canActivate(context('staff', needsBoth, accessOf(['warehouse'])))).toThrow();
    expect(
      guard.canActivate(context('staff', needsBoth, accessOf(['warehouse'], ['cost.view']))),
    ).toBe(true);
  });

  it('lets a handler declaration replace the class one', () => {
    const ctx = context(
      'staff',
      { controller: [Permission('people.manage')], handler: [Permission('stock.view')] },
      accessOf(['support']),
    );

    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('lets any hat of the route audience through @AnyHat(), and no one without one', () => {
    expect(
      guard.canActivate(context('staff', { handler: [AnyHat()] }, accessOf(['media_buyer']))),
    ).toBe(true);
    expect(() =>
      guard.canActivate(context('staff', { handler: [AnyHat()] }, accessOf([]))),
    ).toThrow();
  });

  it('answers 403 when no Access is on the request', () => {
    expect(
      answerOf(() => guard.canActivate(context('staff', { handler: [AnyHat()] }))),
    ).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });
  });

  it.each(['public', 'portal', 'hook'] as const)(
    'leaves a %s route to the guards before it',
    (audience) => {
      expect(guard.canActivate(context(audience, {}))).toBe(true);
    },
  );
});
