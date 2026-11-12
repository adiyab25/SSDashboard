import { OrdersError } from '../../orders/orders.errors.js';
import { ShopifyOrderMappingError } from './order-mapper.js';

/** `OrderNumberTaken` as the upper case failure code `ORDER_NUMBER_TAKEN`, at most 64 characters. */
export function upperCode(code: string): string {
  return code
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .toUpperCase()
    .slice(0, 64);
}

/**
 * The stable code of an error the orders module or the order mapper raised (a mapping refusal's
 * own code, an orders domain error as `upperCode`), or null for anything else. It does not
 * separate lock timeouts from refusals: a caller that retries those checks them first. Never
 * reads a message, so no personal data reaches a code.
 */
export function orderErrorCodeOf(error: unknown): string | null {
  if (error instanceof ShopifyOrderMappingError) return error.code;
  if (error instanceof OrdersError) return upperCode(error.code);
  return null;
}
