import { AsyncLocalStorage } from 'node:async_hooks';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CapabilityHooks } from '../modules/capability-hooks.js';
import { ModuleRegistry } from '../modules/module-registry.js';

/** The cut of the Operations lapse a `pre_lapse` capability counts its open items against. */
export interface PreLapseCut {
  /** The lapse instant: records opened before it are the wind down's. */
  readonly before: string;
  /** Local 00:00 of the lapse day plus `operations_wind_down_pickup_days` (AC-18, D5). */
  readonly pickupWindowEndsAt: string;
}

/**
 * The open wind down items of the Operations `pre_lapse` capabilities (spec 0009, AC-15, AC-18):
 * the count whose zero ends the wind down early once the pickup window has passed. It answers a
 * number only when every Operations `pre_lapse` capability of the registry registered an
 * `openItems` hook and each answered a non negative safe integer; otherwise null (nothing to
 * count, a hook missing, throwing, or answering anything else), so the wind down then ends only by
 * its length. A count asked for while one is already running in the same async flow (a hook that
 * calls back into the license) answers null at once, so a hook can never make the count loop. It
 * logs a failed hook by its capability key only, never what it answered.
 */
@Injectable()
export class PreLapseItems {
  private readonly logger = new Logger('License');
  private readonly counting = new AsyncLocalStorage<true>();

  /** Takes the module registry (which capabilities count) and the capability hooks. */
  constructor(
    @Inject(ModuleRegistry) private readonly registry: ModuleRegistry,
    @Inject(CapabilityHooks) private readonly hooks: CapabilityHooks,
  ) {}

  /** The summed open items for `cut`, or null when they cannot all be counted. */
  async count(cut: PreLapseCut): Promise<number | null> {
    if (this.counting.getStore()) return null;
    return this.counting.run(true, () => this.sum(cut));
  }

  private async sum(cut: PreLapseCut): Promise<number | null> {
    const keys = this.registry
      .modules()
      .flatMap((module) => module.capabilities)
      .filter((c) => c.bundle === 'operations' && c.windDown === 'pre_lapse')
      .map((c) => c.key);
    if (keys.length === 0) return null;
    let total = 0;
    for (const key of keys) {
      const openItems = this.hooks.of(key).openItems;
      if (!openItems) return null;
      let answer: unknown;
      try {
        answer = await openItems({
          before: cut.before,
          pickupWindowEndsAt: cut.pickupWindowEndsAt,
        });
      } catch {
        answer = undefined;
      }
      if (typeof answer !== 'number' || !Number.isSafeInteger(answer) || answer < 0) {
        this.logger.warn(`Open wind down items of ${key} could not be counted`);
        return null;
      }
      total += answer;
    }
    return total;
  }
}
