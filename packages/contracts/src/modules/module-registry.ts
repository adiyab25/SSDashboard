import { defineModule, type ModuleDefinition } from './module-definition.js';

/**
 * Every api module and capability whose code exists today (spec 0009, AC-6, *Module registry*,
 * milestone 3): the twelve core modules (`channels`, `customers`, and `orders` joined with their
 * code from specs 0015, 0014, and 0013; `connectors` lands as the stand-in module of spec 0013
 * milestone 2 with the outbound command reads, and gains `connectors.shopify.sync` with spec 0015
 * task 6's connect job) and
 * the five core job capabilities. A module or capability row lands only with the code that does
 * its work (the `connectors` capabilities with spec 0015, `consignment`, the orders capabilities,
 * and the Operations and Warehouse capabilities arrive with their features, exactly as the spec's
 * table names them). The api reads it through `ModuleRegistry`,
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
  defineModule({
    key: 'channels',
    bundle: 'core',
    toggle: false,
    requires: [],
    label: 'modules.channels.label',
    description: 'modules.channels.description',
    capabilities: [],
  }),
  defineModule({
    key: 'connectors',
    bundle: 'core',
    toggle: false,
    requires: ['channels'],
    label: 'modules.connectors.label',
    description: 'modules.connectors.description',
    capabilities: [
      // Spec 0015 task 6: owns the shared `connector-shopify` queue (the connect job today; the
      // inbox, sweeps, backfill, and hourly check join it in later tasks) and serves
      // `ConnectionsController`. Core, so it never stops; its backfill is declared with the
      // sweep (task 12), never called by the platform.
      {
        key: 'connectors.shopify.sync',
        bundle: 'core',
        kind: 'read',
        windDown: 'none',
        workOf: [],
        label: 'modules.capabilities.connectorsShopifySync',
      },
    ],
  }),
  defineModule({
    key: 'customers',
    bundle: 'core',
    toggle: false,
    requires: [],
    label: 'modules.customers.label',
    description: 'modules.customers.description',
    capabilities: [],
  }),
  defineModule({
    key: 'orders',
    bundle: 'core',
    toggle: false,
    requires: [],
    label: 'modules.orders.label',
    description: 'modules.orders.description',
    capabilities: [],
  }),
]);
