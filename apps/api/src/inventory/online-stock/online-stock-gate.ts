import { Injectable } from '@nestjs/common';
import type { OnlineGateAction, OnlineGateCheck } from '@ssdashboard/contracts';
import type { MessageKey } from '@ssdashboard/i18n';
import type { Executor } from '../../database/sql.js';

/**
 * What a registered check answers for a location (spec 0011 AC-19): the keys of
 * `OnlineGateCheck`, with `label` and `action.label` typed as catalog message keys so the web can
 * translate them and no English text crosses the api.
 */
export interface OnlineGateCheckResult {
  /** Stable key owned by the registering module, for example `orders.open_orders_held`. */
  key: string;
  /** A `@ssdashboard/i18n` message key. */
  label: MessageKey;
  /** True when the location may go online as far as this check is concerned. */
  passed: boolean;
  /** The check's own number to show (items it looked at). */
  count: number;
  /** The route that fixes a failed check; its label is a message key too. */
  action?: { method: OnlineGateAction['method']; path: string; label: MessageKey };
}

/**
 * One check another module registers (spec 0011, Domain events and registries): `run` reads
 * through the executor it is given (a transaction while a location is moved), never writes, and
 * never reads inventory tables itself.
 */
export interface OnlineGateCheckProvider {
  /** Stable key owned by the registering module; one provider per key. */
  readonly key: string;
  /** Evaluates the check for the location that wants to go online. */
  run(locationId: string, executor: Executor): Promise<OnlineGateCheckResult>;
}

/** A second check was registered under a key already taken: a programming error. */
export class OnlineGateKeyDuplicate extends Error {
  /** Takes the key that was registered twice. */
  constructor(key: string) {
    super(`An online gate check is already registered under the key ${key}`);
    this.name = 'OnlineGateKeyDuplicate';
  }
}

/**
 * The registry of online gate checks (spec 0011 AC-19), filled by other modules from their own
 * `onModuleInit` (orders registers `orders.open_orders_held`, connectors its Shopify checks), so
 * inventory imports neither. `evaluate` runs every registered check in registration order; with
 * nothing registered the gate runs only its own built in check. It never lets one module's
 * check decide for another, and it never writes.
 */
@Injectable()
export class OnlineStockGate {
  private readonly providers: OnlineGateCheckProvider[] = [];

  /** Adds a check; a key that is already registered throws `OnlineGateKeyDuplicate`. */
  register(provider: OnlineGateCheckProvider): void {
    if (this.providers.some((existing) => existing.key === provider.key)) {
      throw new OnlineGateKeyDuplicate(provider.key);
    }
    this.providers.push(provider);
  }

  /** Runs every registered check for the location, in registration order. */
  async evaluate(locationId: string, executor: Executor): Promise<OnlineGateCheck[]> {
    const results: OnlineGateCheck[] = [];
    for (const provider of this.providers) {
      const result = await provider.run(locationId, executor);
      results.push({ ...result, key: provider.key });
    }
    return results;
  }
}
