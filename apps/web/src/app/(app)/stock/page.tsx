import { StockPage } from '@/inventory/stock-page';

// Server components render only the shell; stock loads in a client component.
export default function Stock() {
  return <StockPage />;
}
