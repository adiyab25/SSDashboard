'use client';

import type { ReactNode } from 'react';
import { SELECT_CLASS } from '@/shared/select-class';

/**
 * One labelled filter drop down of the SKU list: a native `select`, so the keyboard and screen
 * readers work with no extra code. The caller passes the translated label and the `option`s.
 * It must never hold text of its own.
 */
export function SkuFilterSelect({
  id,
  label,
  value,
  onChange,
  children,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-40 flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <select
        id={id}
        className={SELECT_CLASS}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
    </div>
  );
}
