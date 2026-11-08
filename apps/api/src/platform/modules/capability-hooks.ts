import { Inject, Injectable } from '@nestjs/common';
import type {
  OffImpactCommands,
  OffImpactInFlight,
  OffImpactPartnerStock,
  StopReason,
} from '@ssdashboard/contracts';
import { ModuleRegistry } from './module-registry.js';

/** Why the supervisor fails a capability's waiting outbound commands (AC-10, AC-21). */
export type CommandStopReason = 'MODULE_OFF' | 'STEP_OFF';

/** What one capability adds to the off dialog (AC-30); every part is optional. */
export interface OffImpactPart {
  inFlight?: readonly OffImpactInFlight[];
  /** Pieces per partner, `totalValue` included: the platform strips it without `cost.view`. */
  partnerStock?: readonly OffImpactPartnerStock[];
  /** True when the dialog must ask for typed confirmation (AC-12). */
  typedConfirmation?: boolean;
}

/**
 * The hooks a capability may register with the platform (spec 0009, AC-6): `openItems` (how many
 * records opened before `before` are still open, for an `until_closed` capability), `backfill`
 * (catch up mirror state for a gap, never acting toward a customer or an outside system, AC-27),
 * `onDisable` (called by the worker's supervisor when the capability stops being runnable, with
 * the reason; it must be idempotent, because it runs again at a worker start while the capability
 * stays stopped), and `offImpact` (what the off dialog shows, AC-30).
 */
export interface CapabilityHookSet {
  openItems?: (cut: { before: string }) => Promise<number>;
  backfill?: (gap: { from: string; to: string }) => Promise<void>;
  onDisable?: (stop: { state: 'off' | 'read_only'; reason: StopReason }) => Promise<void>;
  offImpact?: () => Promise<OffImpactPart>;
}

/**
 * The outbound command rule (spec 0009, AC-10, AC-21, task 17): the connectors module (spec
 * 0015) registers the one port with `ConnectorsService.failWaitingCommands(capability, reason)`
 * behind it; until it lands, only a test fixture does, and every call answers zero.
 */
export interface OutboundCommandPort {
  /** Marks the capability's (or only that step's) `waiting` commands `failed` with `reason`. */
  failWaitingCommands: (
    capability: string,
    reason: CommandStopReason,
    step?: string,
  ) => Promise<number>;
  /** The capability's (or step's) `waiting` commands by kind, for the off dialog. */
  waitingCommands: (capability: string, step?: string) => Promise<readonly OffImpactCommands[]>;
}

/** Raised at start when a hook names an unknown capability or registers twice. */
export class CapabilityHookConflict extends Error {
  /** Takes the plain words of what clashed. */
  constructor(message: string) {
    super(message);
    this.name = 'CapabilityHookConflict';
  }
}

/**
 * Where capabilities register their hooks and where the connectors module registers the command
 * port (spec 0009, AC-6, AC-10, AC-30), each from its own `onModuleInit`, in the api and in the
 * worker alike. The supervisor, the module state service, and the off impact read them. It never
 * calls a hook on its own and never logs what a hook returns.
 */
@Injectable()
export class CapabilityHooks {
  private readonly hooks = new Map<string, CapabilityHookSet>();
  private commands: OutboundCommandPort | undefined;

  /** Takes the registry, to refuse a hook of a capability it does not list. */
  constructor(@Inject(ModuleRegistry) private readonly registry: ModuleRegistry) {}

  /** Registers one capability's hooks. Throws `CapabilityHookConflict` for an unknown or repeated one. */
  register(capability: string, hooks: CapabilityHookSet): void {
    if (!this.registry.capability(capability)) {
      throw new CapabilityHookConflict(`Hooks for ${capability}, which the registry does not list`);
    }
    if (this.hooks.has(capability)) {
      throw new CapabilityHookConflict(`Hooks for ${capability} are registered twice`);
    }
    this.hooks.set(capability, hooks);
  }

  /** Registers the outbound command port. Throws `CapabilityHookConflict` for a second one. */
  registerCommands(port: OutboundCommandPort): void {
    if (this.commands) throw new CapabilityHookConflict('Two outbound command ports registered');
    this.commands = port;
  }

  /** The hooks of one capability, or none. */
  of(capability: string): CapabilityHookSet {
    return this.hooks.get(capability) ?? {};
  }

  /** Every capability that registered hooks. */
  registered(): string[] {
    return [...this.hooks.keys()];
  }

  /**
   * The `MODULE_OFF` and `STEP_OFF` command rule (AC-10, AC-21): fails the capability's (or the
   * step's) waiting outbound commands through the registered port; zero without one.
   */
  failWaitingCommands(
    capability: string,
    reason: CommandStopReason,
    step?: string,
  ): Promise<number> {
    return this.commands?.failWaitingCommands(capability, reason, step) ?? Promise.resolve(0);
  }

  /** The capability's (or step's) waiting commands by kind; empty without a port. */
  waitingCommands(capability: string, step?: string): Promise<readonly OffImpactCommands[]> {
    return this.commands?.waitingCommands(capability, step) ?? Promise.resolve([]);
  }
}
