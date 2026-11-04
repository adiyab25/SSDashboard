import { AuthFrame } from '@/auth/auth-frame';

// Outside the app shell: the sign in screens have no navigation, user menu or session check.
export default function AuthLayout({ children }: LayoutProps<'/'>) {
  return <AuthFrame>{children}</AuthFrame>;
}
