import { z } from 'zod';
import { defineSetting } from './setting-definition.js';

/**
 * The Policies section of the settings registry (spec 0009, *Policy knobs*, AC-22): each knob is
 * changed only by a holder of `settings.manage` with a reason. Later features add their knobs
 * here in their own build.
 */
export const POLICY_SETTINGS = [
  defineSetting({
    key: 'operations_wind_down_days',
    // Never shorter than the carrier's normal cash window (domain review D8).
    schema: z.number().int().min(60).max(365),
    default: 60,
    bundle: 'operations',
    group: 'policies',
    whoMayChange: 'settings.manage',
    reason: 'required',
    exposure: 'staff',
    sqlRead: false,
    kind: 'value',
    label: 'settings.entries.operationsWindDownDays.label',
    description: 'settings.entries.operationsWindDownDays.description',
  }),
  defineSetting({
    key: 'operations_wind_down_pickup_days',
    // Days after the lapse in which a delivery for an order confirmed before it is followed (D5).
    schema: z.number().int().min(0).max(14),
    default: 3,
    bundle: 'operations',
    group: 'policies',
    whoMayChange: 'settings.manage',
    reason: 'required',
    exposure: 'staff',
    sqlRead: false,
    kind: 'value',
    label: 'settings.entries.operationsWindDownPickupDays.label',
    description: 'settings.entries.operationsWindDownPickupDays.description',
  }),
] as const;
