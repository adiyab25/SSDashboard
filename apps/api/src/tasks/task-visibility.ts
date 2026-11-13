import {
  HAT_PERMISSIONS,
  InternalHat,
  TASK_TYPES,
  type Permission,
  type TaskTypeDefinition,
} from '@ssdashboard/contracts';

/** The hats and permissions a visibility decision reads: the caller's `Access`, narrowed. */
export interface VisibilityCaller {
  readonly userId: string;
  readonly hats: readonly string[];
  readonly has: (permission: Permission) => boolean;
}

/** What the caller may see in My work, decided before any SQL (spec 0016 AC-5, review B1). */
export interface VisibilityPlan {
  readonly userId: string;
  /** Types whose required permission the caller holds; nothing else ever appears. */
  readonly visibleTypes: readonly string[];
  /** The internal hats the caller wears: their unassigned queues are hers. */
  readonly hats: readonly InternalHat[];
  /** Hats with no active holder, queues only a manager sees (empty for anyone else). */
  readonly orphanHats: readonly InternalHat[];
  /**
   * For each required permission among the visible types: the types, and the active people who
   * may hold them. A task assigned to anyone else (disabled, or no longer holding the permission)
   * has fallen back to its hat queue.
   */
  readonly fallback: readonly { types: readonly string[]; eligible: readonly string[] }[];
}

/**
 * Works out what the caller sees from her hats and permissions and who is active in each hat
 * (`HatDirectory.holdersByHat`, read once per request). Pure. Milestone 1 rules of AC-5: her own
 * tasks; the unassigned tasks (or fallen back ones) of her internal hats; and for a manager the
 * unassigned tasks of any hat nobody active wears. "Overdue held by someone else" and the team
 * view are milestone 2.
 */
export function visibilityPlan(
  caller: VisibilityCaller,
  holders: ReadonlyMap<InternalHat, readonly string[]>,
): VisibilityPlan {
  const types = Object.entries(TASK_TYPES) as [string, TaskTypeDefinition][];
  const visible = types.filter(([, definition]) => caller.has(definition.requiredPermission));
  const byPermission = new Map<Permission, string[]>();
  for (const [code, definition] of visible) {
    byPermission.set(definition.requiredPermission, [
      ...(byPermission.get(definition.requiredPermission) ?? []),
      code,
    ]);
  }
  const fallback = [...byPermission].map(([permission, codes]) => {
    const eligible = new Set<string>();
    for (const hat of InternalHat.options) {
      if (!HAT_PERMISSIONS[hat].includes(permission)) continue;
      for (const userId of holders.get(hat) ?? []) eligible.add(userId);
    }
    return { types: codes, eligible: [...eligible].sort() };
  });
  const hats = InternalHat.options.filter((hat) => caller.hats.includes(hat));
  const isManager = hats.includes('manager');
  const orphanHats = isManager
    ? InternalHat.options.filter((hat) => (holders.get(hat) ?? []).length === 0)
    : [];
  return {
    userId: caller.userId,
    visibleTypes: visible.map(([code]) => code),
    hats,
    orphanHats,
    fallback,
  };
}
