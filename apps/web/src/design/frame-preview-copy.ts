import type { CoreLanguage } from '@ssdashboard/i18n';

/** The sample brand of the frame previews: the green the design system is drawn against. */
export const SAMPLE_BRAND_ACCENT = '#0A7C39';

/** A mid ochre that fails both foregrounds, to show the neutral fallback (DESIGN.md worked examples). */
export const REJECTED_BRAND_ACCENT = '#A9780B';

/** A sample logo: a white leaf shape, as an inline SVG data URI so the preview needs no file. */
export const SAMPLE_LOGO_URL = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><path d="M10 26C10 15 16 9 27 9c0 11-6 17-17 17Z" fill="#fff"/></svg>',
)}`;

/** The sample text of one language in the dev only frame previews. */
export type PreviewCopy = {
  brandName: string;
  title: string;
  body: string;
  orderLabel: string;
  action: string;
  rejectedTitle: string;
  partnerName: string;
  partnerTitle: string;
  partnerBody: string;
  navLabel: string;
  tabs: readonly string[];
  refusal: (accent: string, ratio: number, suggestion: string) => string;
};

/**
 * Sample text of the dev only frame previews, in both languages. It is exempt from the message
 * dictionary (spec 0003, AC-12): the previews never ship, and these strings are not product text.
 */
export const PREVIEW_COPY: Record<CoreLanguage, PreviewCopy> = {
  en: {
    brandName: 'Dar Zeinab',
    title: 'Exchanges and returns',
    body: 'Enter your order number and we will find your items.',
    orderLabel: 'Order number',
    action: 'Find my order',
    rejectedTitle: 'Brand colour refused',
    partnerName: 'Showroom Zamalek',
    partnerTitle: 'Statements',
    partnerBody: 'Your consignment statements will appear here.',
    navLabel: 'Partner sections',
    tabs: ['Statements', 'Stock at your location', 'Settlement'],
    /** Says the accent was refused, with its best ratio and the suggestion. */
    refusal: (accent, ratio, suggestion) =>
      `${accent} was refused: its best contrast is ${ratio}, below 4.5. The portal keeps the neutral primary. Suggestion: ${suggestion}.`,
  },
  ar: {
    brandName: 'دار زينب',
    title: 'الاستبدال والإرجاع',
    body: 'أدخل رقم طلبك وسنعثر على منتجاتك.',
    orderLabel: 'رقم الطلب',
    action: 'ابحث عن طلبي',
    rejectedTitle: 'لون العلامة مرفوض',
    partnerName: 'معرض الزمالك',
    partnerTitle: 'كشوف الحساب',
    partnerBody: 'ستظهر هنا كشوف حساب البضاعة بالأمانة.',
    navLabel: 'أقسام الشريك',
    tabs: ['كشوف الحساب', 'المخزون في موقعك', 'التسوية'],
    /** Says the accent was refused, with its best ratio and the suggestion. */
    refusal: (accent, ratio, suggestion) =>
      `تم رفض ${accent}: أفضل تباين له ${ratio} وهو أقل من 4.5. تبقى البوابة على اللون الأساسي المحايد. الاقتراح: ${suggestion}.`,
  },
};
