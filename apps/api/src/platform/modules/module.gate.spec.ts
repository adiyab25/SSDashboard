import { HttpException, type ExecutionContext } from '@nestjs/common';
import { defineModule, MODULE_REGISTRY, type EffectiveState } from '@ssdashboard/contracts';
import { describe, expect, it, vi } from 'vitest';
import { Audience, type AudienceName } from '../audience/audience.decorator.js';
import { ModuleGate, routeAnswers } from './module.gate.js';
import { ModuleRegistry } from './module-registry.js';
import type { ModuleStateService } from './module-state.service.js';
import { RequiresCapability, RequiresModule } from './requires-module.decorator.js';

const OPS = defineModule({
  key: 'ops',
  bundle: 'operations',
  toggle: true,
  requires: [],
  label: 'modules.platform.label',
  description: 'modules.platform.description',
  capabilities: [
    {
      key: 'ops.finish',
      bundle: 'operations',
      kind: 'write',
      windDown: 'until_closed',
      workOf: [],
      label: 'modules.capabilities.mailSend',
    },
  ],
});
const registry = new ModuleRegistry([...MODULE_REGISTRY, OPS]);

/** A handler function of a controller class, as Nest hands it to a guard. */
function handlerOf(controller: abstract new () => object, name: string): object {
  return (controller.prototype as Record<string, object>)[name] as object;
}

function contextOf(controller: object, handler: object, method: string): ExecutionContext {
  return {
    getClass: () => controller,
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => ({ method }) }),
  } as unknown as ExecutionContext;
}

function gateWith(state: EffectiveState) {
  const stateOf = vi.fn(() => Promise.resolve(state));
  return { gate: new ModuleGate(registry, { stateOf } as unknown as ModuleStateService), stateOf };
}

/** The answer of the gate: true, or the thrown answer's status and code. */
async function answer(gate: ModuleGate, context: ExecutionContext) {
  try {
    return await gate.canActivate(context);
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    return { status: error.getStatus(), body: error.getResponse() };
  }
}

const OFF: EffectiveState = { state: 'off', reason: 'not_licensed', since: null };
const READ_ONLY: EffectiveState = { state: 'read_only', reason: 'toggled_off', since: null };
const LIMITED: EffectiveState = {
  state: 'limited',
  before: '2027-01-01T00:00:00Z',
  reason: 'toggled_off',
};
const ON: EffectiveState = { state: 'on', since: null };

// Spec 0009, AC-8: the module gate.
describe('routeAnswers (AC-8)', () => {
  it.each<[AudienceName, string, EffectiveState['state'], boolean]>([
    ['staff', 'GET', 'off', false],
    ['staff', 'POST', 'off', false],
    ['staff', 'GET', 'read_only', true],
    ['staff', 'POST', 'read_only', false],
    ['staff', 'DELETE', 'read_only', false],
    ['staff', 'POST', 'limited', true],
    ['staff', 'POST', 'on', true],
    ['partner', 'GET', 'read_only', true],
    ['partner', 'PATCH', 'read_only', false],
    ['partner', 'GET', 'off', false],
    ['public', 'GET', 'off', false],
    ['portal', 'POST', 'limited', false],
    ['portal', 'POST', 'on', true],
    ['portal', 'GET', 'limited', true],
    ['portal', 'GET', 'read_only', true],
    ['portal', 'GET', 'off', false],
    ['hook', 'POST', 'off', true],
    ['hook', 'POST', 'read_only', true],
  ])('a %s %s route of a %s module answers: %s', (audience, method, state, answers) => {
    expect(routeAnswers(audience, method, state)).toBe(answers);
  });
});

describe('ModuleGate (AC-8)', () => {
  @Audience('staff')
  @RequiresModule('ops')
  class OpsController {
    read(): void {}
    write(): void {}
  }
  @Audience('staff')
  @RequiresModule('platform')
  class CoreController {
    write(): void {}
  }
  @Audience('staff')
  @RequiresModule('nowhere')
  class UnknownController {
    read(): void {}
  }
  @Audience('staff')
  class BareController {
    read(): void {}
  }
  @Audience('staff')
  @RequiresModule('ops')
  class NarrowingController {
    @RequiresCapability('ops.finish')
    finish(): void {}
  }

  it('answers 404 MODULE_OFF for a route of an off module and lets a read only GET through', async () => {
    const off = gateWith(OFF).gate;
    expect(
      await answer(off, contextOf(OpsController, handlerOf(OpsController, 'read'), 'GET')),
    ).toEqual({
      status: 404,
      body: { code: 'MODULE_OFF', message: 'Not available on this install.' },
    });
    const readOnly = gateWith(READ_ONLY).gate;
    expect(
      await answer(readOnly, contextOf(OpsController, handlerOf(OpsController, 'read'), 'GET')),
    ).toBe(true);
    expect(
      await answer(readOnly, contextOf(OpsController, handlerOf(OpsController, 'write'), 'POST')),
    ).toMatchObject({ status: 404, body: { code: 'MODULE_OFF' } });
    const limited = gateWith(LIMITED).gate;
    expect(
      await answer(limited, contextOf(OpsController, handlerOf(OpsController, 'write'), 'POST')),
    ).toBe(true);
  });

  it('never reads a state for a core route', async () => {
    const { gate, stateOf } = gateWith(OFF);
    expect(
      await answer(gate, contextOf(CoreController, handlerOf(CoreController, 'write'), 'POST')),
    ).toBe(true);
    expect(stateOf).not.toHaveBeenCalled();
  });

  it('reads the handler narrowing before the class', async () => {
    const { gate, stateOf } = gateWith(ON);
    await answer(
      gate,
      contextOf(NarrowingController, handlerOf(NarrowingController, 'finish'), 'POST'),
    );
    expect(stateOf).toHaveBeenCalledWith('ops.finish');
  });

  it('answers 500 MODULE_MISSING for a route without a known declaration', async () => {
    const { gate } = gateWith(ON);
    for (const controller of [UnknownController, BareController]) {
      expect(
        await answer(gate, contextOf(controller, handlerOf(controller, 'read'), 'GET')),
      ).toMatchObject({ status: 500, body: { code: 'MODULE_MISSING' } });
    }
  });
});
