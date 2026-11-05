import { ResetPasswordForm } from '@/auth/reset-password-form';

/** Reset and invite are one screen: `?invite=1` only changes the wording. */
export default function ResetPasswordPage() {
  return <ResetPasswordForm />;
}
