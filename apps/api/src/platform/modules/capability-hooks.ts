import { Inject, Injectable } from '@nestjs/common';
import type {
  BackfillGap,
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
 * The cut an `openItems` hook counts against: `before`, and for an Operations capability cut at the
 * Operations lapse (`pre_lapse` in the license's count, `until_closed` in the module states) also the
 * end of the pickup window, so it can count deliveries in the wind down scope without asking the
 * license.
 */
export interface OpenItemsCut {
  readonly before: string;
  readonly pickupWindowEndsAt?: string;
}

/**
 * The hooks a capability may register with the platform (spec 0009, AC-6): `openItems` (how many
 * records opened before `before` are still open, for an `until_closed` capability; for an
 * Operations `pre_lapse` one, the open wind down items whose zero ends the wind down early, AC-18,
 * so every `pre_lapse` capability registers one, answering 0 when it has nothing to count),
 * `backfill` (catch up mirror state for a gap, the `BackfillGap` contract: never acting toward a
 * customer or an outside system, AC-27),
 * `onDisable` (called by the worker's supervisor when the capability stops being runnable, with
 * the reason; it must be idempotent, because it runs again at a worker start while the capability
 * stays stopped), and `offImpact` (what the off dialog shows, AC-30). An `openItems` hook answers
 * a non negative whole number from its own module's tables and never calls `LicenseService` or
 * `ModuleStateService`: they call it while they compute, so a call back would wait on itself.
 * Both refuse it at once instead (the license's count answers null to a nested count, and the
 * module states throw `ModuleStateReentry`), so the hook counts as failed: unknown wind down items
 * never end the wind down early, and an unknown `until_closed` count keeps the work finishable.
 */
export interface CapabilityHookSet {
  openItems?: (cut: OpenItemsCut) => Promise<number>;
  backfill?: (gap: BackfillGap) => Promise<void>;
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

/**
 * The manager tasks the platform asks for (spec 0009, AC-18, AC-29): `wind_down_ended` (one task
 * when the Operations wind down ends, linking to the settlement module's "open after the wind
 * down" list; `key` is the lapse instant) and `stock_out_source_missing` (one task each time a
 * capability with `requiresOneOf` enters the reason `no_stock_out_source`: Shopify's own counts
 * lead now, and once a source returns, count the online location before confirming a new
 * preview; `key` is `<capability>:<episode>`, the episode being the instant the last source
 * stopped, or `never` when no source ever ran).
 */
export type PlatformTaskKind = 'wind_down_ended' | 'stock_out_source_missing';

/** One manager task the platform asks for: its kind, its key, and the dates it names. */
export interface PlatformTaskRequest {
  readonly kind: PlatformTaskKind;
  /** Names one episode of the kind: a second request with the same kind and key opens nothing. */
  readonly key: string;
  /** The capability it is about (`stock_out_source_missing`). */
  readonly capability?: string;
  /** The lapse instant (`wind_down_ended`). */
  readonly lapsedAt?: string;
  /** When the wind down ended (`wind_down_ended`). */
  readonly endedAt?: string;
}

/**
 * The manager task port (spec 0009, AC-18, AC-29): the tasks module (feature 17) registers it and
 * opens at most one task per `kind` and `key`, ever: a request repeated at a worker start, or by
 * two processes, opens nothing, and a task the manager closed is never opened again by the same
 * key. Until it lands only a test fixture registers one, and every request is dropped.
 */
export interface ManagerTaskPort {
  /** Opens the task unless one of the same kind and key was ever opened. Must be idempotent. */
  open: (request: PlatformTaskRequest) => Promise<void>;
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
 * Where capabilities register their hooks, where the connectors module registers the command
 * port, and where the tasks module registers the manager task port (spec 0009, AC-6, AC-10,
 * AC-18, AC-29, AC-30), each from its own `onModuleInit`, in the api and in the
 * worker alike. The supervisor, the module state service, and the off impact read them. It never
 * calls a hook on its own and never logs what a hook returns.
 */
@Injectable()
export class CapabilityHooks {
  private readonly hooks = new Map<string, CapabilityHookSet>();
  private commands: OutboundCommandPort | undefined;
  private tasks: ManagerTaskPort | undefined;

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

  /** Registers the manager task port. Throws `CapabilityHookConflict` for a second one. */
  registerTasks(port: ManagerTaskPort): void {
    if (this.tasks) throw new CapabilityHookConflict('Two manager task ports registered');
    this.tasks = port;
  }

  /**
   * Asks for a manager task (AC-18, AC-29) through the registered port; nothing without one.
   * The port opens at most one per kind and key, ever, so callers may ask again safely.
   */
  openTask(request: PlatformTaskRequest): Promise<void> {
    return this.tasks?.open(request) ?? Promise.resolve();
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
