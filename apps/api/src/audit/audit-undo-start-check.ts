import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { AuditUndoRegistry } from './audit-undo.registry.js';

/**
 * The start check of the undo (spec 0010, Key invariants, review M4R1): once every module has run
 * its `onModuleInit`, where owners register their handlers, it stops the process
 * (`AuditUndoHandlerMissing`) if an undoable code of the registry has no handler, so a missing
 * handler fails the deploy instead of a manager's click. It is provided only by
 * `AuditUndoModule`, which only the api's `AppModule` imports, so it runs only where the undo
 * route is served: the worker loads `AuditModule` to record entries but never serves an undo, and
 * must never stop on this check. It holds nothing and reads no data.
 */
@Injectable()
export class AuditUndoStartCheck implements OnApplicationBootstrap {
  /** Takes the registry the owners registered their handlers in. */
  constructor(@Inject(AuditUndoRegistry) private readonly registry: AuditUndoRegistry) {}

  /** Runs after every module's `onModuleInit`: stops a start with a missing handler. */
  onApplicationBootstrap(): void {
    this.registry.assertComplete();
  }
}
