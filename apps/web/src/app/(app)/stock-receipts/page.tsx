import { ReceiptsPage } from '@/inventory/receipts-page';

// Server components render only the shell; the list loads in a client component.
export default function StockReceipts() {
  return <ReceiptsPage />;
}
