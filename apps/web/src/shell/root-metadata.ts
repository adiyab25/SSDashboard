import type { Metadata } from 'next';

/**
 * Default page title and description for the staff audiences. Each root layout re-exports it as
 * its own `metadata`, because Next.js reads `metadata` from the layout file itself. It must never
 * carry per client text.
 */
export const rootMetadata: Metadata = {
  title: 'SSDashboard',
  description: 'Warehouse and ERP back office',
};
