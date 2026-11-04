import { AccountPage } from '@/account/account-page';

// Server components render only the shell; the details load in a client component.
export default function Account() {
  return <AccountPage />;
}
