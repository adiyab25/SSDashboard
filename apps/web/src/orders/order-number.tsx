import { orderLabelOf } from '@ssdashboard/contracts';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';

/**
 * An order's number with its store beside it, `ESS/#1001` (spec 0013, AC-3), always left to right.
 * Every place an order number is shown goes through this, so two stores' `#1001` never read alike.
 */
export function OrderNumber({
  order,
  className,
}: {
  order: { storeCode: string; orderNumber: string };
  className?: string;
}) {
  return <LtrText className={className}>{orderLabelOf(order)}</LtrText>;
}
