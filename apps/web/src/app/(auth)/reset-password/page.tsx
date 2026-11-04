import { ResetPasswordForm } from '@/auth/reset-password-form';

// The reset and invite pages are one screen: `?invite=1` only changes the wording.
export default function ResetPasswordPage() {
  return <ResetPasswordForm />;
}
