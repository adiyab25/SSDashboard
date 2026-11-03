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
      theme: 'Theme',
      language: 'Language',
      languageError: 'Could not load {{language}}. Try again.',
      signOut: 'Sign out',
      signOutError: 'Could not sign out. Try again.',
      roles: {
        admin: 'Administrator',
        staff: 'Staff',
      },
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
  auth: {
    required: 'Required',
    signIn: {
      title: 'Sign in',
      description: 'Use the email and password your administrator gave you.',
      email: 'Email',
      password: 'Password',
      submit: 'Sign in',
      emailRequired: 'Enter your email address.',
      emailInvalid: 'Enter a valid email address, like name@example.com.',
      passwordRequired: 'Enter your password.',
      invalidCredentials: 'The email or password is not right. Check both and try again.',
      disabled: 'This account is disabled. Ask an administrator for help.',
      rateLimited: 'Too many attempts. Wait a minute, then try again.',
      failed: 'Could not sign in. Check your connection and try again.',
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
