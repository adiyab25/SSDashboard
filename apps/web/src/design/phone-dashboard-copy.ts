// Sample text for the phone dashboard (spec 0003, AC-12: gallery specimens are exempt from the
// message dictionary). The real dashboard gets its own catalog keys; this stands in for them.

/** The words of the sample dashboard in one language. */
export type PhoneDashboardCopy = {
  brand: string;
  title: string;
  fresh: string;
  owed: string;
  owedDetail: string;
  bosta: string;
  partners: string;
  confirmedYesterday: string;
  failedRate: string;
  today: string;
  todayDetail: string;
  provisional: string;
  needsYou: string;
  more: (hidden: number) => string;
  tabsLabel: string;
  tabs: { today: string; orders: string; cash: string; more: string };
  chips: { owed: string; failed: string; provisional: string; confirmed: string };
  rows: string[];
  tableCaption: string;
  tableHead: { order: string; customer: string; total: string; state: string };
  tableStates: { confirmed: string; failed: string; provisional: string };
  names: string[];
};

/** English and Arabic text of the sample dashboard. */
export const PHONE_DASHBOARD_COPY: Record<'en' | 'ar', PhoneDashboardCopy> = {
  en: {
    brand: 'Sample Brand',
    title: 'Today',
    fresh: 'Confirmed through 4 Nov, today is provisional',
    owed: 'Cash owed to you',
    owedDetail: 'Bosta and partners together',
    bosta: 'Bosta',
    partners: 'Partners',
    confirmedYesterday: 'Confirmed yesterday',
    failedRate: 'Failed deliveries',
    today: 'Today so far',
    todayDetail: 'Orders placed, not yet confirmed',
    provisional: 'Provisional',
    needsYou: 'Needs you',
    /** The "N more" link text. */
    more: (hidden) => `${hidden} more`,
    tabsLabel: 'Main',
    tabs: { today: 'Today', orders: 'Orders', cash: 'Cash', more: 'More' },
    chips: {
      owed: 'Cash owed',
      failed: 'Failed',
      provisional: 'Not confirmed',
      confirmed: 'Confirmed',
    },
    rows: [
      'SS-48192 failed delivery, call the customer',
      'SS-48177 has no answer after 3 calls',
      'Bosta cash from 2 Nov is late',
      'Partner Nile Showroom statement is ready',
      'SS-48140 is stuck for 3 days',
    ],
    tableCaption: 'Latest orders',
    tableHead: { order: 'Order', customer: 'Customer', total: 'Total', state: 'State' },
    tableStates: {
      confirmed: 'Confirmed',
      failed: 'Delivery failed',
      provisional: 'Not confirmed',
    },
    names: ['Mona Abdelrahman', 'Omar Hassan', 'Salma Nabil'],
  },
  ar: {
    brand: 'علامة تجريبية',
    title: 'اليوم',
    fresh: 'مؤكد حتى 4 نوفمبر، وأرقام اليوم مبدئية',
    owed: 'نقد مستحق لك',
    owedDetail: 'بوسطة والشركاء معاً',
    bosta: 'بوسطة',
    partners: 'الشركاء',
    confirmedYesterday: 'مؤكد أمس',
    failedRate: 'فشل التسليم',
    today: 'اليوم حتى الآن',
    todayDetail: 'طلبات وردت ولم تؤكد بعد',
    provisional: 'مبدئي',
    needsYou: 'يحتاج إليك',
    /** The "N more" link text. */
    more: (hidden) => `${hidden} أخرى`,
    tabsLabel: 'الرئيسية',
    tabs: { today: 'اليوم', orders: 'الطلبات', cash: 'النقد', more: 'المزيد' },
    chips: { owed: 'نقد مستحق', failed: 'فشل', provisional: 'غير مؤكد', confirmed: 'مؤكد' },
    rows: [
      'SS-48192 فشل التسليم، اتصل بالعميل',
      'SS-48177 لم يرد بعد 3 اتصالات',
      'نقد بوسطة من 2 نوفمبر متأخر',
      'كشف حساب الشريك معرض النيل جاهز',
      'SS-48140 متوقف منذ 3 أيام',
    ],
    tableCaption: 'آخر الطلبات',
    tableHead: { order: 'الطلب', customer: 'العميل', total: 'الإجمالي', state: 'الحالة' },
    tableStates: { confirmed: 'مؤكد', failed: 'فشل التسليم', provisional: 'غير مؤكد' },
    names: ['منى عبد الرحمن', 'عمر حسن', 'سلمى نبيل'],
  },
};
