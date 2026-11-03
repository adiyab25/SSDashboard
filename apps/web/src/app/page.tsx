import { t } from '@/i18n/t';
import { ClientName } from '@/shell/client-name';
import { ApiStatus } from './api-status';

// Server components render only the shell; data loads in client components.
export default function Home() {
  return (
    <>
      <header className="flex h-14 items-center border-b px-4">
        <ClientName className="font-semibold" />
      </header>
      <main id="main-content" tabIndex={-1} className="p-6 outline-none">
        <h1 className="text-xl font-semibold">{t('home.title')}</h1>
        <ApiStatus />
      </main>
    </>
  );
}
