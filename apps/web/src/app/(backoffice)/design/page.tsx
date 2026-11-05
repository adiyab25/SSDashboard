import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DesignLoader } from '@/design/design-loader';

/** The page title for the development only gallery. */
export const metadata: Metadata = { title: 'Design system · SSDashboard' };

/**
 * Development only: production answers 404, and the gallery loads through an `import()` behind
 * the same inlined check, so production bundles never carry it.
 */
export default function DesignPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <DesignLoader />;
}
