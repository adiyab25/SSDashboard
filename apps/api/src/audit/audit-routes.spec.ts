import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { PlatformModule } from '../platform/platform.module.js';
import { AuditExportModule } from './audit-export.module.js';
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

// Spec 0010, review M3R6: the export lives in a leaf module so the audit module never imports the
// platform module, and that leaf must be routed before the entry detail's `:id`.
describe('audit routes and module imports', () => {
  it('meets the export module before the audit module, so /export is never read as an id', () => {
    const order = scanOrder(AppModule);

    expect(order.indexOf(AuditExportModule)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(AuditExportModule)).toBeLessThan(order.indexOf(AuditModule));
  });

  it('keeps the platform module out of the audit module, at any depth', () => {
    expect(scanOrder(AuditModule)).not.toContain(PlatformModule);
  });
});
