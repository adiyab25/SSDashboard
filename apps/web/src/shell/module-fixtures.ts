import type { ModuleStateView, ModuleStatesResponse } from '@ssdashboard/contracts';

/** One state view with the fields a spec does not care about left empty. */
export function stateView(overrides: Partial<ModuleStateView> & { key: string }): ModuleStateView {
  return { state: 'on', since: null, before: null, reason: null, ...overrides };
}

/** A `GET /api/platform/modules` answer for specs: nothing off, no notice, unless overridden. */
export function modulesAnswer(overrides: Partial<ModuleStatesResponse> = {}): ModuleStatesResponse {
  return { modules: [], capabilities: [], staffNotices: [], licenseNotices: null, ...overrides };
}
