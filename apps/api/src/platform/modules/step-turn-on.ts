import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  capabilityOfStep,
  NO_STOCK_OUT_SOURCE,
  StepFact,
  type StepTurnOn,
} from '@ssdashboard/contracts';
import { CapabilityHooks } from './capability-hooks.js';
import { ModuleRegistry } from './module-registry.js';
import { ModuleStateService, UnknownModuleKey } from './module-state.service.js';

/**
 * Whether an executing step may be switched on now (spec 0009, AC-21, AC-29), and the facts its
 * turn on dialog shows. The order is the spec's: the bundle is licensed (checked first by
 * `SettingsService.write`, 409 `NOT_LICENSED`), then the platform's own precondition (its gating
 * capability is not `read_only` for `no_stock_out_source`: `NO_STOCK_OUT_SOURCE`), then each
 * feature precondition in its declared order (`CapabilityHooks.registerPreconditions`). A step
 * whose capability is stopped for another reason (toggled off, lapsed) may still be switched on;
 * it stays not runnable until its capability is `on` (*Effective state*, S1). A precondition that
 * throws counts as failed (fail closed) and logs its code, never its error text. It never writes.
 */
@Injectable()
export class StepTurnOnCheck {
  private readonly logger = new Logger('StepTurnOn');

  /** Takes the registry (which capability a step gates), the hooks, and the module states. */
  constructor(
    @Inject(ModuleRegistry) private readonly registry: ModuleRegistry,
    @Inject(CapabilityHooks) private readonly hooks: CapabilityHooks,
    @Inject(ModuleStateService) private readonly states: ModuleStateService,
  ) {}

  /**
   * The turn on check of `step`: ready with the passing preconditions' facts, or the code of the
   * first precondition that fails. `fresh` reads the module states through the database (the
   * write path does); otherwise from the 30 second snapshot (the settings list does). Throws
   * `UnknownModuleKey` for a key no capability lists as a step.
   */
  async check(step: string, options: { fresh?: boolean } = {}): Promise<StepTurnOn> {
    const gate = capabilityOfStep(this.registry.modules(), step);
    if (!gate) throw new UnknownModuleKey(step);
    const state = await this.states.stateOf(gate.capability.key, options);
    if (state.state === 'read_only' && state.reason === 'no_stock_out_source') {
      return { ready: false, precondition: NO_STOCK_OUT_SOURCE };
    }
    const facts: StepFact[] = [];
    for (const precondition of this.hooks.preconditionsOf(step)) {
      let passed = false;
      let found: readonly unknown[] = [];
      try {
        const answer = await precondition.check();
        passed = answer.ok;
        if (answer.ok) found = answer.facts ?? [];
      } catch {
        this.logger.warn(`Precondition ${precondition.code} of ${step} could not be checked`);
      }
      if (!passed) return { ready: false, precondition: precondition.code };
      // Only well formed facts reach the dialog: a label key and whole numbers.
      for (const fact of found) {
        const parsed = StepFact.safeParse(fact);
        if (parsed.success) facts.push(parsed.data);
      }
    }
    return { ready: true, facts };
  }
}
