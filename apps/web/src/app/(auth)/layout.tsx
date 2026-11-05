import { AuthFrame } from '@/auth/auth-frame';

/**
 * Frame of the sign in screens. Outside the app shell: no navigation, user menu or session
 * check.
 */
export default function AuthLayout({ children }: LayoutProps<'/'>) {
  return <AuthFrame>{children}</AuthFrame>;
}
