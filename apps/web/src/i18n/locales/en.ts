/**
 * Every English UI string. It is the source language: bundled in the main chunk, the type
 * source for `useTranslation()` keys, and the fallback for any key another language lacks.
 * Plural keys end in `_one` and `_other`; Arabic needs all six forms (see `ar.ts`).
 */
export const en = {
  shell: {
    skipLink: 'Skip to main content',
    clientNameFallback: 'SSDashboard',
    nav: {
      label: 'Main',
      groups: {
        general: 'General',
      },
      items: {
        home: 'Home',
        design: 'Design system',
      },
    },
    sidebar: {
      toggle: 'Toggle sidebar',
      mobileLabel: 'Navigation',
    },
    topbar: {
      menu: 'Open navigation',
      palette: 'Search pages',
    },
    palette: {
      title: 'Go to a page',
      description: 'Type to filter the pages, then press Enter to open the highlighted one.',
      placeholder: 'Search pages…',
      noResults: 'No pages match.',
      groups: {
        pages: 'Pages',
      },
    },
    user: {
      menu: 'User menu',
      placeholderName: 'Staff',
      placeholderInitial: 'S',
      theme: 'Theme',
      language: 'Language',
      languageError: 'Could not load {{language}}. Try again.',
      signOut: 'Sign out',
      signOutHint: 'Available after sign in',
    },
    theme: {
      light: 'Light',
      dark: 'Dark',
      system: 'System',
    },
    locations: {
      label: 'Location',
      all: 'All locations',
      noneYet: 'No locations yet',
      loading: 'Loading locations…',
      error: 'Locations unavailable',
      errorDetail: 'The locations could not be loaded.',
      retry: 'Try again',
      search: 'Search locations…',
      noResults: 'No locations match.',
      count_one: '{{count}} location',
      count_other: '{{count}} locations',
    },
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
