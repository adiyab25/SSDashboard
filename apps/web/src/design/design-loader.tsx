'use client';

import dynamic from 'next/dynamic';

/** The gallery, loaded on demand in development and an empty component in production. */
export const DesignLoader =
  process.env.NODE_ENV === 'production'
    ? () => null
    : dynamic(() => import('./design-gallery').then((module) => module.DesignGallery));
