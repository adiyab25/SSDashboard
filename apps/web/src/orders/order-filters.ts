import type {
  CashState,
  FulfillmentState,
  OrderListQuery,
  OrderOutcome,
  OrderType,
} from '@ssdashboard/contracts';

/**
 * What the order list is narrowed by (spec 0013, AC-4). Kept in component state, never in the
 * address: `q` can be a phone, which must not reach a URL, a proxy log, or browser history.
 */
export interface OrderFilters {
  storeId: string;
  channelId: string;
  /** Every id of a merged customer is found by the api; set from the customer page link. */
  customerId: string;
  fulfillment: readonly FulfillmentState[];
  cash: readonly CashState[];
  outcome: OrderOutcome | '';
  type: OrderType | '';
  hold: boolean;
  short: boolean;
  /** Operating days, `YYYY-MM-DD`, inclusive. */
  dayFrom: string;
  dayTo: string;
  /** A phone in any form, or an order number: always sent as a POST body. */
  q: string;
}

/** No filter set. */
export const EMPTY_FILTERS: OrderFilters = {
  storeId: '',
  channelId: '',
  customerId: '',
  fulfillment: [],
  cash: [],
  outcome: '',
  type: '',
  hold: false,
  short: false,
  dayFrom: '',
  dayTo: '',
  q: '',
};

/** How many orders one page asks for. */
export const ORDER_PAGE_SIZE = 50;

/**
 * The filters as the api's `OrderListQuery` shape, with only the fields that are set. The api
 * validates it with the contract schema; this builds it and never validates.
 */
export function queryOf(
  filters: OrderFilters,
  cursor: string | undefined,
  limit: number = ORDER_PAGE_SIZE,
): Partial<OrderListQuery> {
  return {
    ...(filters.storeId && { storeId: filters.storeId }),
    ...(filters.channelId && { channelId: filters.channelId }),
    ...(filters.customerId && { customerId: filters.customerId }),
    ...(filters.fulfillment.length > 0 && { fulfillment: [...filters.fulfillment] }),
    ...(filters.cash.length > 0 && { cash: [...filters.cash] }),
    ...(filters.outcome && { outcome: filters.outcome }),
    ...(filters.type && { type: filters.type }),
    ...(filters.hold && { hold: true }),
    ...(filters.short && { short: true }),
    ...(filters.dayFrom && { dayFrom: filters.dayFrom }),
    ...(filters.dayTo && { dayTo: filters.dayTo }),
    ...(filters.q && { q: filters.q }),
    ...(cursor && { cursor }),
    limit,
  };
}

/** True when any filter or the search text is set. */
export function isFiltered(filters: OrderFilters): boolean {
  return (
    JSON.stringify({ ...filters, customerId: '' }) !==
    JSON.stringify({ ...EMPTY_FILTERS, customerId: '' })
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A customer id from the address (`/orders?customerId=...`), or empty when it is not a uuid. */
export function customerIdFromAddress(value: string | null): string {
  return value !== null && UUID.test(value) ? value : '';
}
