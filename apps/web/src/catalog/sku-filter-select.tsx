'use client';

import type { ReactNode } from 'react';

const SELECT =
  'h-control w-full min-w-0 rounded-md border border-input bg-transparent px-2 text-base shadow-xs outline-none focus-ring md:text-sm dark:bg-input/30';

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
        className={SELECT}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
    </div>
  );
}
