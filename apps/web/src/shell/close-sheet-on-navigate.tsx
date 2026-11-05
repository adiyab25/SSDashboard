'use client';

import { useSidebar } from '@ssdashboard/ui/components/sidebar';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Closes the phone sheet once a page is picked. Its own Suspense leaf: the pathname is unknown
 * while Next.js prerenders a route with dynamic params (cache components).
 */
export function CloseSheetOnNavigate() {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();
  useEffect(() => {
    setOpenMobile(false);
  }, [pathname, setOpenMobile]);
  return null;
}
