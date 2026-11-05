import { ApiStatus } from './api-status';
import { HomeTitle } from './home-title';

/** The back office home; text and data load in client components. */
export default function Home() {
  return (
    <>
      <HomeTitle />
      <ApiStatus />
    </>
  );
}
