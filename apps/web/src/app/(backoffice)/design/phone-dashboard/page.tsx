import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PhoneDashboardLoader } from '@/design/phone-dashboard-loader';

/** The page title for the development only phone dashboard sample. */
export const metadata: Metadata = { title: 'Phone dashboard sample · SSDashboard' };

/**
 * Development only (spec 0003, AC-20): the sample phone first dashboard as a page of its own, so
 * a test can load it at 360 by 800 inside the real shell. Production answers 404 (the proxy path
 * list, and this check), and the sample loads through an `import()` behind the same inlined check.
 */
export default function PhoneDashboardPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <PhoneDashboardLoader />;
}
