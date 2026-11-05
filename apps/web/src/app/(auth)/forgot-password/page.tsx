import { ForgotPasswordForm } from '@/auth/forgot-password-form';

/**
 * The forgot password screen. The server renders only the frame; the form and its text are a
 * client component.
 */
export default function ForgotPasswordPage() {
  return <ForgotPasswordForm />;
}
