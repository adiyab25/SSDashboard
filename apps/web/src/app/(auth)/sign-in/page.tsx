import { SignInForm } from '@/auth/sign-in-form';

// Server components render only the shell; the form and its text are a client component.
export default function SignInPage() {
  return <SignInForm />;
}
