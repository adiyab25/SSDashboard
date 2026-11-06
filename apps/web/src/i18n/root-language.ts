import { lang } from 'next/root-params';

/**
 * The raw `lang` root parameter of the portal and partner layouts. `next typegen` does not yet
 * detect a root parameter that sits under a route group, so the generated module types the getter
 * as `any`; this wrapper gives it its real type in one place. The value is untrusted text from the
 * URL: match it with `matchPublicLanguage` before any use. Server components only.
 */
export const rootLanguage = lang as () => Promise<string | undefined>;
