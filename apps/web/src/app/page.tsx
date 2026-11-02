import { ApiStatus } from './api-status';

// Server components render only the shell; data loads in client components.
export default function Home() {
  return (
    <main className="mx-auto max-w-xl p-8">
      <h1 className="text-2xl font-semibold">SSDashboard</h1>
      <ApiStatus />
    </main>
  );
}
