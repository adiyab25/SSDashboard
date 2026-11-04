import { SkusPage } from '@/catalog/skus-page';

// Server components render only the shell; the SKU list loads in a client component.
export default function Skus() {
  return <SkusPage />;
}
