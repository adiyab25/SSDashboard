import { t } from '@/i18n/t';
import { ApiStatus } from './api-status';

// Server components render only the shell; data loads in client components.
export default function Home() {
  return (
    <>
      <h1 className="text-xl font-semibold">{t('home.title')}</h1>
      <ApiStatus />
    </>
  );
}
