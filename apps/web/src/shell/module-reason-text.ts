import type { StopReason } from '@ssdashboard/contracts';
import type { MessageKey } from '@ssdashboard/i18n';

/** The catalog key of the sentence that says why something is not on (spec 0009, AC-7). */
export const REASON_KEYS = {
  not_licensed: 'shell.modules.reasons.not_licensed',
  lapsed: 'shell.modules.reasons.lapsed',
  toggled_off: 'shell.modules.reasons.toggled_off',
  step_off: 'shell.modules.reasons.step_off',
  no_stock_out_source: 'shell.modules.reasons.no_stock_out_source',
  requires_off: 'shell.modules.reasons.requires_off',
} as const satisfies Record<StopReason, MessageKey>;
