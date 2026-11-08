import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  capabilityOfStep,
  type OffImpact,
  type OffImpactCommands,
  type OffImpactInFlight,
  type OffImpactPartnerStock,
} from '@ssdashboard/contracts';
import { describeError } from '../../database/pg-error.js';
import { SettingError } from '../settings/settings.errors.js';
import { CapabilityHooks } from './capability-hooks.js';
import { OffImpactUnavailable } from './module.errors.js';
import { ModuleRegistry } from './module-registry.js';

/** Adds counts of the same name together, keeping first seen order. */
function summed<T extends { count: number }>(rows: readonly T[], nameOf: (row: T) => string): T[] {
  const byName = new Map<string, T>();
  for (const row of rows) {
    const name = nameOf(row);
    const held = byName.get(name);
    byName.set(name, held ? { ...held, count: held.count + row.count } : { ...row });
  }
  return [...byName.values()];
}

/**
 * What turning a module toggle or an executing step off would drop (spec 0009, AC-30, the
 * `GET /api/settings/:key/off-impact` answer): the waiting outbound commands by kind, from the
 * command port (connectors, spec 0015); for a module, each capability's `offImpact` hook (in
 * flight records per area, the pieces per partner, typed confirmation). A step's off fails its
 * commands only: a step never finishes old work, so it lists no in flight records. Pieces at a
 * partner always ask for typed confirmation (AC-12); their `totalValue` (value at cost) is left
 * out unless the caller holds `cost.view`. A hook or the port that throws answers
 * `OffImpactUnavailable` (503 `OFF_IMPACT_UNAVAILABLE`), logged as a warning with a safe text.
 * Reads only; it never changes a thing.
 */
@Injectable()
export class OffImpactReader {
  private readonly logger = new Logger('ModuleState');

  /** Takes the registry and the capability hooks. */
  constructor(
    @Inject(ModuleRegistry) private readonly registry: ModuleRegistry,
    @Inject(CapabilityHooks) private readonly hooks: CapabilityHooks,
  ) {}

  /** The impact of turning `key` off; `SettingUnknown` when it is neither a toggle nor a step. */
  async read(key: string, viewer: { showCost: boolean }): Promise<OffImpact> {
    const module = this.registry.toggledModule(key);
    const stepOf =
      this.registry.settingDefinition(key)?.kind === 'executing_step'
        ? capabilityOfStep(this.registry.modules(), key)
        : undefined;
    if (!module && !stepOf) {
      throw new SettingError('SettingUnknown', 'Not a module switch or an automation step');
    }
    const capabilities = module ? module.capabilities.map((c) => c.key) : [stepOf!.capability.key];
    const step = module ? undefined : key;

    const commands: OffImpactCommands[] = [];
    const inFlight: OffImpactInFlight[] = [];
    const partnerStock: OffImpactPartnerStock[] = [];
    let typedConfirmation = false;
    for (const capability of capabilities) {
      try {
        commands.push(...(await this.hooks.waitingCommands(capability, step)));
        const impact = module ? this.hooks.of(capability).offImpact : undefined;
        if (!impact) continue;
        const part = await impact();
        inFlight.push(...(part.inFlight ?? []));
        partnerStock.push(...(part.partnerStock ?? []));
        typedConfirmation ||= part.typedConfirmation === true;
      } catch (error) {
        this.logger.warn(`The off impact of ${capability} failed: ${describeError(error)}`);
        throw new OffImpactUnavailable(capability);
      }
    }
    return {
      waitingCommands: summed(commands, (row) => row.kind),
      inFlight: summed(inFlight, (row) => row.area),
      partnerStock: partnerStock.map(({ totalValue, ...line }) =>
        viewer.showCost && totalValue !== undefined ? { ...line, totalValue } : line,
      ),
      typedConfirmation: typedConfirmation || partnerStock.some((line) => line.pieces > 0),
    };
  }
}
