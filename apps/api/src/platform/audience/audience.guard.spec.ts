import {
  ForbiddenException,
  InternalServerErrorException,
  type ExecutionContext,
} from '@nestjs/common';
import type { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { Audience, AUDIENCE_KEY, type AudienceName } from './audience.decorator.js';
import { AudienceGuard } from './audience.guard.js';

function contextFor(controller: object, request: object): ExecutionContext {
  return {
    getClass: () => controller,
    getHandler: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function controllerWith(audience: AudienceName | undefined): object {
  class Subject {}
  if (audience) Audience(audience)(Subject);
  return Subject;
}

const guard = new AudienceGuard();
const staffRequest = { staff: { id: 's1' } };

function responseOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return (error as HttpException).getResponse();
  }
  return undefined;
}

describe('AudienceGuard', () => {
  it('denies a controller with no audience, with a stable code', () => {
    const context = contextFor(controllerWith(undefined), staffRequest);

    expect(() => guard.canActivate(context)).toThrow(InternalServerErrorException);
    expect(responseOf(() => guard.canActivate(context))).toMatchObject({
      code: 'AUDIENCE_MISSING',
    });
  });

  it('lets a staff session reach a staff route', () => {
    expect(guard.canActivate(contextFor(controllerWith('staff'), staffRequest))).toBe(true);
  });

  it.each<AudienceName>(['portal', 'partner', 'hook'])(
    'answers 403 WRONG_AUDIENCE to a staff session on a %s route',
    (audience) => {
      const context = contextFor(controllerWith(audience), staffRequest);

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
      expect(responseOf(() => guard.canActivate(context))).toMatchObject({
        code: 'WRONG_AUDIENCE',
      });
    },
  );

  it('answers 403 to nobody on a staff route', () => {
    const context = contextFor(controllerWith('staff'), {});

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('lets anyone reach a public route, signed in or not', () => {
    expect(guard.canActivate(contextFor(controllerWith('public'), {}))).toBe(true);
    expect(guard.canActivate(contextFor(controllerWith('public'), staffRequest))).toBe(true);
  });

  it('treats an unknown audience value as missing', () => {
    class Bad {}
    Reflect.defineMetadata(AUDIENCE_KEY, 'admin', Bad);

    expect(() => guard.canActivate(contextFor(Bad, staffRequest))).toThrow(
      InternalServerErrorException,
    );
  });

  it('does not let a subclass inherit its parent audience', () => {
    const parent = controllerWith('public') as new () => object;
    class Child extends parent {}

    expect(() => guard.canActivate(contextFor(Child, {}))).toThrow(InternalServerErrorException);
  });

  it('refuses a second @Audience on one class', () => {
    class Twice {}
    Audience('staff')(Twice);

    expect(() => Audience('public')(Twice)).toThrow(/more than one @Audience/);
  });
});
