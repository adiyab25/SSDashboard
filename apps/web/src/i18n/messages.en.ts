/** Every English UI string. Feature 5 moves these into the localization library. */
export const messages = {
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
      direction: 'Direction',
      signOut: 'Sign out',
      signOutHint: 'Available after sign in',
    },
    theme: {
      light: 'Light',
      dark: 'Dark',
      system: 'System',
    },
    direction: {
      ltr: 'Left to right',
      rtl: 'Right to left',
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
