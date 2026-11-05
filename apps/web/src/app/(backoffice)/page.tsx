import { ApiStatus } from './api-status';
import { HomeTitle } from './home-title';

// Server components render only the shell; text and data load in client components.
export default function Home() {
  return (
    <>
      <HomeTitle />
      <ApiStatus />
    </>
  );
}
