import { publicStaticParams } from '@/i18n/public-language';
import { rootLanguage } from '@/i18n/root-language';
import { PublicRootFrame } from '@/shell/public-root-frame';
import { publicMetadata } from '@/shell/public-metadata';

/** Page title and a neutral description of the portal, in the URL's language. */
export const generateMetadata = publicMetadata;

/** Both languages prerender; any other `lang` is a 404 (the proxy answers it before this runs). */
export function generateStaticParams() {
  return publicStaticParams();
}

/**
 * Root layout of the public portal (spec 0007, section 2; spec 0004, AC-16): the document in
 * the URL's language, no staff app shell, no staff session check, no staff navigation. The page
 * is public.
 */
export default async function PortalLayout({ children }: LayoutProps<'/[lang]'>) {
  return <PublicRootFrame segment={await rootLanguage()}>{children}</PublicRootFrame>;
}
