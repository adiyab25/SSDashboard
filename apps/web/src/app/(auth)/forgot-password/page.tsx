import { ForgotPasswordForm } from '@/auth/forgot-password-form';

// Server components render only the shell; the form and its text are a client component.
export default function ForgotPasswordPage() {
  return <ForgotPasswordForm />;
}
