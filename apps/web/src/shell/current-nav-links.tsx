'use client';

import { usePathname } from 'next/navigation';
import { NavLinks } from './nav-links';
import type { NavItem } from './nav';

/** `NavLinks` with the live pathname; must sit inside a Suspense boundary (see `AppSidebar`). */
export function CurrentNavLinks({ items }: { items: NavItem[] }) {
  return <NavLinks items={items} pathname={usePathname()} />;
}
