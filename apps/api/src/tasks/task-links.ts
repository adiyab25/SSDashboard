import { Injectable } from '@nestjs/common';
import type { TaskLinkedType, TaskLinkLabel } from '@ssdashboard/contracts';

/**
 * How the module that owns a kind of record gives a task on it a label and a web path (spec 0016,
 * *TaskLinks*, pulled forward from milestone 2 so that `orders` imports `tasks` and never the
 * other way). `exists` (does the record exist and may this caller see it, for a person opening a
 * case) is left out until milestone 4, which needs it.
 */
export interface TaskLinkResolver {
  /**
   * Labels and web paths for a page of ids; an id the owner does not know is left out. Never a
   * phone, a name, an address, or a note.
   */
  describe(
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, { readonly label: TaskLinkLabel; readonly path: string }>>;
}

/** A second resolver for one linked type: a wiring mistake that stops the process at start. */
export class TaskLinkResolverTaken extends Error {
  /** Names the linked type and both owners (module names, never data). */
  constructor(linkedType: string, first: string, second: string) {
    super(
      `The ${linkedType} task link resolver of ${first} is already registered; ${second} tried another`,
    );
    this.name = 'TaskLinkResolverTaken';
  }
}

/**
 * The registry of task link resolvers (spec 0016 AC-12). The module that owns a record kind
 * registers one resolver from its `onModuleInit`; the tasks module asks it, once per page and
 * kind, for the labels and paths of the rows it lists. A kind with no resolver shows its kind
 * only (`label` and `path` null). It holds no data and never reads another module's tables.
 */
@Injectable()
export class TaskLinks {
  private readonly resolvers = new Map<
    TaskLinkedType,
    { resolver: TaskLinkResolver; owner: string }
  >();

  /**
   * Registers the resolver of one linked type, naming the owning module. A second resolver for
   * the same type throws `TaskLinkResolverTaken`, so two modules cannot both claim a record kind.
   */
  register(linkedType: TaskLinkedType, resolver: TaskLinkResolver, owner: string): void {
    const taken = this.resolvers.get(linkedType);
    if (taken) throw new TaskLinkResolverTaken(linkedType, taken.owner, owner);
    this.resolvers.set(linkedType, { resolver, owner });
  }

  /**
   * Labels and paths of these ids of one linked type; an empty map when the type has no
   * resolver. Called once per page and kind.
   */
  async describe(
    linkedType: TaskLinkedType,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, { readonly label: TaskLinkLabel; readonly path: string }>> {
    const entry = this.resolvers.get(linkedType);
    if (!entry || ids.length === 0) return new Map();
    return entry.resolver.describe(ids);
  }
}
