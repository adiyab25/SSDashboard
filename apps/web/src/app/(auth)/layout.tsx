import { AuthFrame } from '@/auth/auth-frame';
import { rootMetadata } from '@/shell/root-metadata';
import { StaticRootFrame } from '@/shell/static-root-frame';

/** Page title and description of the sign in screens. */
export const metadata = rootMetadata;

/**
 * Root layout and frame of the sign in screens: the shared static document, then the minimal
 * frame. Outside the app shell: no navigation, user menu or session check.
 */
export default function AuthLayout({ children }: LayoutProps<'/'>) {
  return (
    <StaticRootFrame>
      <AuthFrame>{children}</AuthFrame>
    </StaticRootFrame>
  );
}
