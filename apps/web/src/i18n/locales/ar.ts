import type { Catalog } from '../catalog';

/**
 * The Arabic catalog, a lazy chunk (`import('./locales/ar')`). Every key in `en.ts` needs
 * one here; a test checks it. Plural keys carry all six Arabic forms.
 */
export const ar: Catalog = {
  shell: {
    skipLink: 'انتقل إلى المحتوى الرئيسي',
    clientNameFallback: 'SSDashboard',
    nav: {
      label: 'القائمة الرئيسية',
      groups: {
        general: 'عام',
      },
      items: {
        home: 'الرئيسية',
        design: 'نظام التصميم',
      },
    },
    sidebar: {
      toggle: 'تبديل الشريط الجانبي',
      mobileLabel: 'التنقل',
    },
    topbar: {
      menu: 'فتح التنقل',
      palette: 'البحث في الصفحات',
    },
    palette: {
      title: 'الانتقال إلى صفحة',
      description: 'اكتب لتصفية الصفحات، ثم اضغط Enter لفتح الصفحة المحددة.',
      placeholder: 'ابحث في الصفحات…',
      noResults: 'لا توجد صفحات مطابقة.',
      groups: {
        pages: 'الصفحات',
      },
    },
    user: {
      menu: 'قائمة المستخدم',
      placeholderName: 'الموظف',
      placeholderInitial: 'م',
      theme: 'المظهر',
      language: 'اللغة',
      languageError: 'تعذّر تحميل {{language}}. حاول مرة أخرى.',
      signOut: 'تسجيل الخروج',
      signOutHint: 'متاح بعد تسجيل الدخول',
    },
    theme: {
      light: 'فاتح',
      dark: 'داكن',
      system: 'النظام',
    },
    locations: {
      label: 'الموقع',
      all: 'كل المواقع',
      noneYet: 'لا توجد مواقع بعد',
      loading: 'جارٍ تحميل المواقع…',
      error: 'المواقع غير متاحة',
      errorDetail: 'تعذّر تحميل المواقع.',
      retry: 'حاول مرة أخرى',
      search: 'ابحث في المواقع…',
      noResults: 'لا توجد مواقع مطابقة.',
      count_zero: 'لا توجد مواقع',
      count_one: 'موقع واحد',
      count_two: 'موقعان',
      count_few: '{{count}} مواقع',
      count_many: '{{count}} موقعًا',
      count_other: '{{count}} موقع',
    },
  },
  home: {
    title: 'نظرة عامة',
    status: {
      api: 'واجهة البرمجة',
      database: 'قاعدة البيانات',
      version: 'الإصدار',
      checking: 'جارٍ الفحص…',
      unreachable: 'لا يمكن الوصول',
      checkAgain: 'افحص مرة أخرى',
    },
  },
};
