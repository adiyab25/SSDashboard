import type { OrderDetail } from '@ssdashboard/contracts';
import type { Access } from '../../platform/access/access.js';

/**
 * Removes `unitCost` from every line for a caller without `cost.view` (spec 0008 AC-6, spec 0013
 * AC-19): the cost serializer of the order answers. A line of a viewer who holds it keeps the
 * value. It never adds a field and never reads the database.
 */
export function serializeOrderDetail(detail: OrderDetail, access: Access): OrderDetail {
  if (access.has('cost.view')) return detail;
  return {
    ...detail,
    lines: detail.lines.map(({ unitCost: _unitCost, ...line }) => line),
  };
}
