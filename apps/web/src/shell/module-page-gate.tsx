'use client';

import { usePathname } from 'next/navigation';
import { ModuleNotAvailableState } from './module-not-available-state';
import { ModuleNotice } from './module-notice';
import { navItemFor } from './nav';
import { useModuleStates } from './use-module-states';

/**
 * Wraps the page body inside the shell (spec 0009, AC-9): when the module or capability the
 * current address belongs to (`navItems[].module`) is `off` it shows the "not available on this
 * install" state with the one `<h1>` instead of the page; when `read_only` or `limited` it shows
 * the notice above the page. While the module states are unknown, or the address has no nav entry,
 * the page shows untouched: this only explains, the api still answers 404 `MODULE_OFF`. Needs a
 * Suspense boundary above it (`usePathname`).
 */
export function ModulePageGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const item = navItemFor(pathname);
  const { stateOf } = useModuleStates();
  const view = item ? stateOf(item.module) : null;

  if (item && view?.state === 'off') {
    return <ModuleNotAvailableState titleKey={item.labelKey} reason={view.reason} />;
  }
  return (
    <>
      {view && <ModuleNotice view={view} />}
      {children}
    </>
  );
}
