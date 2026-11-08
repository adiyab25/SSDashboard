import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  compareInstants,
  isRunnableState,
  moduleStates,
  openItemCuts,
  type EffectiveState,
  type LicenseNotice,
  type ModuleStates,
  type SwitchFact,
} from '@ssdashboard/contracts';
import type { DatabaseConnection } from '@ssdashboard/db';
import { DATABASE } from '../../database/database.module.js';
import { LICENSE_CHANGED } from '../license/license-events.js';
import { LicenseService } from '../license/license.service.js';
import { SETTINGS_CACHE_LIFETIME_MS, SettingsCache } from '../settings/settings-cache.js';
import { SettingsService } from '../settings/settings.service.js';
import { CapabilityHooks } from './capability-hooks.js';
import { ModuleLimited, ModuleOff } from './module.errors.js';
import { ModuleRegistry } from './module-registry.js';

/** Raised when code asks for the state of a key the registry does not list (a bug). */
export class UnknownModuleKey extends Error {
  /** Takes the key asked for. */
  constructor(readonly key: string) {
    super(`${key} is neither a module, a capability, nor an executing step of the registry`);
    this.name = 'UnknownModuleKey';
  }
}

/** The state every always on key has: `on` since the install. */
const ALWAYS_ON: EffectiveState = Object.freeze({ state: 'on', since: null });

/** One computed snapshot: every state and today's manager license notices. */
interface Snapshot {
  readonly states: ModuleStates;
  readonly notices: LicenseNotice[];
}

/**
 * Every module's, capability's, and executing step's effective state (spec 0009, AC-7, AC-13),
 * computed by the pure `moduleStates` from the live license phases (`LicenseService.bundleFacts`,
 * never a check's recorded phases), the module toggles and step switches (settings), and the open
 * item counts of `until_closed` capabilities (their `openItems` hooks). Cached like settings: a
 * snapshot (with today's license notices beside it) lives at most 30 seconds and is dropped by any
 * settings cache drop (every `NOTIFY ssd_platform_changed`, the license payload included) and by
 * `LicenseChanged`; callers that miss the cache at the same generation share one computation
 * (security review m3, finding 6). A key
 * the registry calls always on (core, untoggled, no `requiresOneOf`) is answered without a read,
 * so core routes and jobs never query. It never writes and never logs a value.
 */
@Injectable()
export class ModuleStateService {
  private readonly logger = new Logger('ModuleState');
  private snapshot: { generation: number; at: number; value: Snapshot } | undefined;
  private inFlight: { generation: number; value: Promise<Snapshot> } | undefined;

  /** Takes the registry, the database (fresh reads), settings, license, the cache, and the hooks. */
  constructor(
    @Inject(ModuleRegistry) private readonly registry: ModuleRegistry,
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(LicenseService) private readonly license: LicenseService,
    @Inject(SettingsCache) private readonly cache: SettingsCache,
    @Inject(CapabilityHooks) private readonly hooks: CapabilityHooks,
  ) {}

  /** Drops the snapshot when a license check in this process moved a phase. */
  @OnEvent(LICENSE_CHANGED)
  licenseChanged(): void {
    this.snapshot = undefined;
    this.inFlight = undefined;
  }

  /**
   * Every state, from the snapshot unless `fresh` (the supervisor's reconcile reads the database
   * through, never the cache).
   */
  async states(options: { fresh?: boolean } = {}): Promise<ModuleStates> {
    return (await this.read(options.fresh === true)).states;
  }

  /** Today's manager license notices, from the same snapshot as the states. */
  async notices(): Promise<LicenseNotice[]> {
    return (await this.read(false)).notices;
  }

  private async read(fresh: boolean): Promise<Snapshot> {
    const generation = this.cache.generation();
    const held = this.snapshot;
    if (
      !fresh &&
      held &&
      held.generation === generation &&
      Date.now() - held.at < SETTINGS_CACHE_LIFETIME_MS
    ) {
      return held.value;
    }
    if (!fresh && this.inFlight?.generation === generation) return this.inFlight.value;
    const value = this.compute(fresh);
    if (!fresh) this.inFlight = { generation, value };
    try {
      const computed = await value;
      // A drop while it computed means a change landed: keep it for this caller only.
      if (generation === this.cache.generation()) {
        this.snapshot = { generation, at: Date.now(), value: computed };
      }
      return computed;
    } finally {
      if (this.inFlight?.value === value) this.inFlight = undefined;
    }
  }

  /** The state of a module, capability, or executing step. Throws `UnknownModuleKey` otherwise. */
  async stateOf(key: string, options: { fresh?: boolean } = {}): Promise<EffectiveState> {
    if (this.registry.alwaysOn(key)) return ALWAYS_ON;
    const states = await this.states(options);
    const found = states.modules.get(key) ?? states.capabilities.get(key) ?? states.steps.get(key);
    if (!found) throw new UnknownModuleKey(key);
    return found;
  }

  /** Whether a module, capability, or step is `on` (AC-13: a core module asks before calling one). */
  async isOn(key: string): Promise<boolean> {
    return (await this.stateOf(key)).state === 'on';
  }

  /**
   * Whether jobs of a capability or step may run now (AC-10, AC-21): `on` or `limited` (a step is
   * never `limited`). Every job handler asks it before any work.
   */
  async isRunnable(key: string, options: { fresh?: boolean } = {}): Promise<boolean> {
    return isRunnableState(await this.stateOf(key, options));
  }

  /** Throws the domain error `ModuleOff` unless the key is `on` (AC-13). */
  async assertOn(key: string): Promise<void> {
    if ((await this.stateOf(key)).state !== 'on') throw new ModuleOff(key);
  }

  /**
   * For a write of a record opened at `recordOpenedAt` (AC-13, AC-28): passes when the capability
   * is `on`, or `limited` and the record was opened before `before`; throws `ModuleLimited` for a
   * record opened at or after it, and `ModuleOff` when the capability is `read_only` or `off`.
   */
  async assertMayFinish(key: string, recordOpenedAt: string | Date): Promise<void> {
    const state = await this.stateOf(key);
    if (state.state === 'on') return;
    if (state.state !== 'limited') throw new ModuleOff(key);
    const opened =
      typeof recordOpenedAt === 'string' ? recordOpenedAt : recordOpenedAt.toISOString();
    // By the instants' text, so the microseconds of `before` count (code review m3, finding 12).
    if (!(compareInstants(opened, state.before) < 0)) throw new ModuleLimited(key, state.before);
  }

  private async compute(fresh: boolean): Promise<Snapshot> {
    const modules = this.registry.modules();
    const executor = fresh ? this.connection.db : undefined;
    const { bundles, notices } = await this.license.moduleFacts();
    const toggles: Record<string, SwitchFact> = {};
    for (const setting of await this.settings.load(this.registry.toggleKeys(), executor)) {
      const module = this.registry.toggledModule(setting.key);
      if (module && setting.hasRow) {
        toggles[module.key] = { enabled: setting.value === true, updatedAt: setting.updatedAt };
      }
    }
    const stepKeys = modules.flatMap((m) => m.capabilities.flatMap((c) => c.steps ?? []));
    const steps: Record<string, SwitchFact> = {};
    for (const setting of await this.settings.load(stepKeys, executor)) {
      steps[setting.key] = { enabled: setting.value === true, updatedAt: setting.updatedAt };
    }
    const openItems: Record<string, number> = {};
    for (const cut of openItemCuts(modules, { bundles, toggles, steps })) {
      const count = this.hooks.of(cut.capability).openItems;
      if (!count) continue;
      try {
        openItems[cut.capability] = await count({ before: cut.before });
      } catch (error) {
        // Unknown counts keep the work finishable rather than stranding it (AC-28).
        openItems[cut.capability] = 1;
        this.logger.warn(
          `Open items of ${cut.capability} could not be counted: ${error instanceof Error ? error.name : 'error'}`,
        );
      }
    }
    return { states: moduleStates(modules, { bundles, toggles, steps, openItems }), notices };
  }
}
