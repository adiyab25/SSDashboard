/** Every English UI string. Feature 5 moves these into the localization library. */
export const messages = {
  shell: {
    clientNameFallback: 'SSDashboard',
  },
  home: {
    title: 'Overview',
    status: {
      api: 'API',
      database: 'Database',
      version: 'Version',
      checking: 'checking…',
      unreachable: 'unreachable',
      checkAgain: 'Check again',
    },
  },
} as const;
