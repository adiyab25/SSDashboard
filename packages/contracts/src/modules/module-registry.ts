import { defineModule, type ModuleDefinition } from './module-definition.js';

/**
 * Every api module and capability whose code exists today (spec 0009, AC-6, *Module registry*,
 * milestone 3): the eight core modules and the five core job capabilities. A module or capability
 * row lands only with the code that does its work (`channels`, `connectors`, `customers`,
 * `orders`, `consignment`, and the Operations and Warehouse capabilities arrive with their
 * features, exactly as the spec's table names them). The api reads it through `ModuleRegistry`,
 * which tests may extend with fixture rows; `module-registry.spec.ts` and the api's folder check
 * hold it to AC-6. Pure data.
 */
export const MODULE_REGISTRY: readonly ModuleDefinition[] = Object.freeze([
  defineModule({
    key: 'platform',
    bundle: 'core',
    toggle: false,
    requires: [],
    label: 'modules.platform.label',
    description: 'modules.platform.description',
    capabilities: [
      {
        key: 'platform.reconcile_modules',
        bundle: 'core',
        kind: 'write',
        windDown: 'none',
        workOf: [],
        label: 'modules.capabilities.platformReconcileModules',
      },
      {
        key: 'platform.license_check',
        bundle: 'core',
        kind: 'read',
        windDown: 'none',
        workOf: [],
        label: 'modules.capabilities.platformLicenseCheck',
      },
    ],
  }),
  defineModule({
    key: 'audit',
    bundle: 'core',
    toggle: false,
    requires: [],
    label: 'modules.audit.label',
    description: 'modules.audit.description',
    capabilities: [],
  }),
  defineModule({
    key: 'identity',
    bundle: 'core',
    toggle: false,
    requires: [],
    label: 'modules.identity.label',
    description: 'modules.identity.description',
    capabilities: [
      {
        key: 'identity.cleanup',
        bundle: 'core',
        kind: 'write',
        windDown: 'none',
        workOf: [],
        label: 'modules.capabilities.identityCleanup',
      },
    ],
  }),
  defineModule({
    key: 'catalog',
    bundle: 'core',
    toggle: false,
    requires: [],
    label: 'modules.catalog.label',
    description: 'modules.catalog.description',
    capabilities: [],
  }),
  defineModule({
    key: 'inventory',
    bundle: 'core',
    toggle: false,
    requires: [],
    label: 'modules.inventory.label',
    description: 'modules.inventory.description',
    capabilities: [
      {
        key: 'inventory.reconcile',
        bundle: 'core',
        kind: 'read',
        windDown: 'none',
        workOf: [],
        label: 'modules.capabilities.inventoryReconcile',
      },
    ],
  }),
  defineModule({
    key: 'partners',
    bundle: 'core',
    toggle: false,
    requires: [],
    label: 'modules.partners.label',
    description: 'modules.partners.description',
    capabilities: [],
  }),
  defineModule({
    key: 'mail',
    bundle: 'core',
    toggle: false,
    requires: [],
    label: 'modules.mail.label',
    description: 'modules.mail.description',
    capabilities: [
      {
        key: 'mail.send',
        bundle: 'core',
        kind: 'write',
        windDown: 'none',
        workOf: [],
        label: 'modules.capabilities.mailSend',
      },
    ],
  }),
  defineModule({
    key: 'health',
    bundle: 'core',
    toggle: false,
    requires: [],
    label: 'modules.health.label',
    description: 'modules.health.description',
    capabilities: [],
  }),
]);
