import type { LicenseNoticeLevel } from '@ssdashboard/contracts';
import { CircleAlertIcon, InfoIcon, TriangleAlertIcon } from 'lucide-react';

/** How each banner level looks: a start border and an icon in the role colour, never the text colour. */
export const LEVEL_LOOK = {
  info: { icon: InfoIcon, border: 'border-s-info', tint: 'text-info' },
  warning: { icon: TriangleAlertIcon, border: 'border-s-warning', tint: 'text-warning' },
  critical: { icon: CircleAlertIcon, border: 'border-s-destructive', tint: 'text-destructive' },
} as const satisfies Record<
  LicenseNoticeLevel,
  { icon: typeof InfoIcon; border: string; tint: string }
>;
