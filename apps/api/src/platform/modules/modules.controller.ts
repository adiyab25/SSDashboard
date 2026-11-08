import { Controller, Get, Inject } from '@nestjs/common';
import {
  externalModuleStateView,
  InternalHat,
  moduleStateView,
  staffNotices,
  type EffectiveState,
  type ModuleStatesResponse,
} from '@ssdashboard/contracts';
import type { Access } from '../access/access.js';
import { CurrentAccess } from '../access/current-access.decorator.js';
import { AnyHat } from '../access/permission.decorator.js';
import { Audience } from '../audience/audience.decorator.js';
import { ModuleRegistry } from './module-registry.js';
import { ModuleStateService } from './module-state.service.js';
import { RequiresModule } from './requires-module.decorator.js';

/**
 * What runs on this install, for every staff hat (spec 0009, AC-9, AC-26): each module's and
 * capability's state, the caller's staff notices (AC-17, internal hats only), and, for a holder of
 * `settings.manage` only, the manager's license notices. A caller who wears no internal hat (only
 * `partner` or `media_buyer`) gets `key` and `state` alone, never when or why something stopped
 * (wave 1 review W8; security review m3, finding 1). The shell hides entries by it. Holds no
 * rule; `ModuleStateService` and the pure `staffNotices` do. Never answers a price or a term.
 */
@Audience('staff')
@AnyHat()
@RequiresModule('platform')
@Controller('platform/modules')
export class ModulesController {
  /** Takes the registry and the state service (states and notices from one snapshot). */
  constructor(
    @Inject(ModuleRegistry) private readonly registry: ModuleRegistry,
    @Inject(ModuleStateService) private readonly states: ModuleStateService,
  ) {}

  /** The states, in registry order, and the notices this caller may see. */
  @Get()
  async list(@CurrentAccess() access: Access): Promise<ModuleStatesResponse> {
    const states = await this.states.states();
    const notices = await this.states.notices();
    const internal = access.hats.some((hat) => InternalHat.safeParse(hat).success);
    const view = (key: string, found: ReadonlyMap<string, EffectiveState>) => {
      const full = moduleStateView(key, found.get(key) ?? { state: 'on', since: null });
      return internal ? full : externalModuleStateView(full);
    };
    const modules = this.registry.modules();
    return {
      modules: modules.map((module) => view(module.key, states.modules)),
      capabilities: this.registry.capabilityKeys().map((key) => view(key, states.capabilities)),
      staffNotices: staffNotices(modules, notices, {
        hats: access.hats,
        permissions: access.permissions,
      }),
      licenseNotices: access.has('settings.manage') ? notices : null,
    };
  }
}
