'use client';

import dynamic from 'next/dynamic';

/** The sample phone dashboard, loaded on demand in development and an empty component in production. */
export const PhoneDashboardLoader =
  process.env.NODE_ENV === 'production'
    ? () => null
    : dynamic(() =>
        import('./phone-dashboard-sample').then((module) => module.PhoneDashboardSample),
      );
