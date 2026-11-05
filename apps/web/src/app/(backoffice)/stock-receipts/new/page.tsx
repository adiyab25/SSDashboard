import { ReceiptFormPage } from '@/inventory/receipt-form';

// Server components render only the shell; the form is a client component.
export default function NewStockReceipt() {
  return <ReceiptFormPage />;
}
