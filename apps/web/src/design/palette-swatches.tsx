'use client';

import { useEffect, useState } from 'react';
import { toHex } from './contrast';

/** Every role the palette shows: the name is the CSS variable, `--name`. */
const ROLES = [
  'background',
  'sidebar',
  'card',
  'popover',
  'muted',
  'accent',
  'foreground',
  'muted-foreground',
  'primary',
  'primary-foreground',
  'primary-edge',
  'border',
  'border-strong',
  'input',
  'ring',
  'success',
  'warning',
  'destructive',
  'destructive-surface',
] as const;

/** Every role of the palette in the current theme, with its live hex. */
export function PaletteSwatches({ version, label }: { version: number; label: string }) {
  const [hexes, setHexes] = useState<Record<string, string>>({});
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const probe = document.createElement('span');
      document.body.append(probe);
      const next: Record<string, string> = {};
      for (const role of ROLES) {
        probe.style.color = `var(--${role})`;
        next[role] = toHex(getComputedStyle(probe).color);
      }
      probe.remove();
      setHexes(next);
    });
    return () => cancelAnimationFrame(frame);
  }, [version]);

  return (
    <ul aria-label={label} className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-4">
      {ROLES.map((role) => (
        <li key={role} className="flex items-center gap-3 rounded-control border p-2">
          <span
            aria-hidden
            className="size-10 shrink-0 rounded-chip border"
            style={{ backgroundColor: `var(--${role})` }}
          />
          <span className="min-w-0">
            <span className="block truncate font-medium">{role}</span>
            <span
              className="font-mono text-xs text-muted-foreground"
              dir="ltr"
              data-testid={`hex-${role}`}
            >
              {hexes[role] ?? '…'}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}
