import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { PlatformModule } from '../platform/platform.module.js';
import { WorkerModule } from '../worker.module.js';
import { AuditExportModule } from './audit-export.module.js';
import { AuditUndoStartCheck } from './audit-undo-start-check.js';
import { AuditUndoController } from './audit-undo.controller.js';
import { AuditUndoModule } from './audit-undo.module.js';
import { AuditUndoRegistry } from './audit-undo.registry.js';
import { AuditUndoService } from './audit-undo.service.js';
import { AuditUndoneWriter } from './audit-undone.writer.js';
import { AuditModule } from './audit.module.js';

/** A module class, or a dynamic module object pointing at one. */
type ModuleRef = { module?: unknown } | (abstract new (...args: never[]) => unknown);

/** The module class behind an import entry. */
function classOf(entry: ModuleRef): unknown {
  return typeof entry === 'function' ? entry : entry.module;
}

/**
 * The modules in the order Nest first meets them: a depth first walk of `imports` from the root,
 * each module before its imports, which is the order its controllers' routes are registered in.
 */
function scanOrder(root: unknown): unknown[] {
  const seen: unknown[] = [];
  const visit = (entry: ModuleRef): void => {
    const module = classOf(entry);
    if (!module || seen.includes(module)) return;
    seen.push(module);
    const found: unknown = Reflect.getMetadata('imports', module);
    const imports = Array.isArray(found) ? (found as ModuleRef[]) : [];
    for (const child of imports) visit(child);
  };
  visit(root as ModuleRef);
  return seen;
}

/** Every class a module graph lists under `metadata` (`providers`, `controllers`, `exports`). */
function listed(root: unknown, metadata: string): unknown[] {
  return scanOrder(root).flatMap((module) => {
    const found: unknown = Reflect.getMetadata(metadata, module as object);
    return Array.isArray(found) ? (found as unknown[]) : [];
  });
}

// Spec 0010, review M3R6: the export lives in a leaf module so the audit module never imports the
// platform module, and that leaf is routed before the entry detail's `:id`.
describe('audit routes and module imports', () => {
  it('meets the export module before the audit module, so a fixed export path is never read as an id', () => {
    const order = scanOrder(AppModule);

    expect(order.indexOf(AuditExportModule)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(AuditExportModule)).toBeLessThan(order.indexOf(AuditModule));
  });

  it('keeps the platform module out of the audit module, at any depth', () => {
    expect(scanOrder(AuditModule)).not.toContain(PlatformModule);
  });
});

// Review M4R1: the undo's start check (every undoable code has a handler) stops the process that
// runs it, so it must run only where the undo route is served: the api (`AppModule`), never the
// worker (`WorkerModule`), which loads `AuditModule` to record entries but serves no undo. A
// future import of the undo module into the worker, or the check moved back onto the registry
// every process loads, fails here in CI instead of crash looping the worker on deploy.
describe('the undo start check runs only in the api', () => {
  it('lists the undo route, its service, the undone writer, and the start check in the api graph', () => {
    expect(scanOrder(AppModule)).toContain(AuditUndoModule);
    expect(listed(AppModule, 'controllers')).toContain(AuditUndoController);
    for (const provider of [AuditUndoService, AuditUndoneWriter, AuditUndoStartCheck]) {
      expect(listed(AppModule, 'providers')).toContain(provider);
    }
  });

  it('keeps the undo module, its route, and its start check out of the worker graph', () => {
    const worker = scanOrder(WorkerModule);

    // The worker does record entries: it loads the audit module and its registry.
    expect(worker).toContain(AuditModule);
    expect(listed(WorkerModule, 'providers')).toContain(AuditUndoRegistry);
    expect(worker).not.toContain(AuditUndoModule);
    expect(listed(WorkerModule, 'controllers')).not.toContain(AuditUndoController);
    expect(listed(WorkerModule, 'providers')).not.toContain(AuditUndoStartCheck);
  });

  it('gives no provider the worker loads a start hook from the audit module', () => {
    const hooked = listed(WorkerModule, 'providers').filter(
      (provider) =>
        typeof provider === 'function' &&
        [AuditModule, AuditUndoModule].some((module) =>
          listed(module, 'providers').includes(provider),
        ) &&
        typeof (provider as { prototype?: { onApplicationBootstrap?: unknown } }).prototype
          ?.onApplicationBootstrap === 'function',
    );

    expect(hooked).toEqual([]);
  });

  it('exports neither the undone writer nor the undo service from any module', () => {
    const exported = listed(AppModule, 'exports');

    expect(exported).not.toContain(AuditUndoneWriter);
    expect(exported).not.toContain(AuditUndoService);
  });
});
