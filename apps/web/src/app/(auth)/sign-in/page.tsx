import { SignInForm } from '@/auth/sign-in-form';

/**
 * The staff sign in screen. The server renders only the frame; the form and its text are a
 * client component.
 */
export default function SignInPage() {
  return <SignInForm />;
}
