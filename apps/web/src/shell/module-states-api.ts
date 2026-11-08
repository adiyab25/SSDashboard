import { ModuleStatesResponse, type ModuleStateView } from '@ssdashboard/contracts';
import { apiRequest } from '@/api/client';

/** Query keys of the module states. */
export const moduleKeys = {
  /** The one answer of `GET /api/platform/modules`, for one invalidation. */
  all: ['platform', 'modules'] as const,
};

/** Every module's and capability's state, the staff notices, and (for managers) license notices. */
export function getModuleStates(signal?: AbortSignal) {
  return apiRequest('GET', '/api/platform/modules', ModuleStatesResponse, { signal });
}

/** One entry's view by key, looked up in modules first and then capabilities; undefined when unknown. */
export function findModuleState(
  answer: { modules: readonly ModuleStateView[]; capabilities: readonly ModuleStateView[] },
  key: string,
): ModuleStateView | undefined {
  return (
    answer.modules.find((view) => view.key === key) ??
    answer.capabilities.find((view) => view.key === key)
  );
}
