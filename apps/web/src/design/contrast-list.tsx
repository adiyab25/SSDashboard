'use client';

import { ContrastPair, type ContrastPairSpec } from './contrast-pair';

/** A two column list of live measured pairs, each re-measured when `version` (the theme) changes. */
export function ContrastList({
  pairs,
  version,
  label,
  single = false,
}: {
  pairs: readonly ContrastPairSpec[];
  version: number;
  label: string;
  /** One column, for a half width panel. */
  single?: boolean;
}) {
  return (
    <ul
      aria-label={label}
      className={`grid grid-cols-[minmax(0,1fr)] gap-2 ${single ? '' : 'sm:grid-cols-2'}`}
    >
      {pairs.map((pair) => (
        <ContrastPair
          key={`${pair.id ?? ''}-${pair.fg}-${pair.bg}-${pair.over ?? ''}`}
          {...pair}
          version={version}
        />
      ))}
    </ul>
  );
}
