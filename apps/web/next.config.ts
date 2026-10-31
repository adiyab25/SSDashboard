import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';

export default function config(phase: string): NextConfig {
  return {
    // One image for every client: nothing per client is baked in at build time.
    output: 'standalone',
    outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),
    cacheComponents: true,
    partialPrefetching: true,
    turbopack: {
      rules: {
        '*.css': {
          loaders: ['@tailwindcss/turbopack'],
          as: '*.css',
        },
      },
    },
    // In an install, Caddy routes /api/* to the api. Locally there is no Caddy,
    // so the dev server forwards it instead. Never part of a production build.
    rewrites() {
      if (phase !== PHASE_DEVELOPMENT_SERVER) return Promise.resolve([]);
      const api = process.env.API_INTERNAL_URL ?? 'http://localhost:3001';
      return Promise.resolve([{ source: '/api/:path*', destination: `${api}/api/:path*` }]);
    },
  };
}
