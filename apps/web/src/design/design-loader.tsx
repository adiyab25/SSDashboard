'use client';

import dynamic from 'next/dynamic';

// The check is inlined at build time, so production bundles drop the import entirely.
export const DesignLoader =
  process.env.NODE_ENV === 'production'
    ? () => null
    : dynamic(() => import('./gallery').then((module) => module.DesignGallery));
