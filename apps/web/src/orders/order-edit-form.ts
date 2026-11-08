import {
  EditReasonCode,
  LineRemovalReasonCode,
  Money,
  moneyInput,
  PriceString,
  quantityInput,
  type OrderDetail,
  type OrderEditBody,
  type OrderEditOperation,
} from '@ssdashboard/contracts';
import { z } from 'zod';

/** The SKU the picker holds on a line. */
const Sku = z.object({
  id: z.string(),
  code: z.string(),
  name: z.object({ en: z.string().optional(), ar: z.string().optional() }),
  price: z.string().nullable().optional(),
});

/** What a person does with a line: leave it, replace it, remove it, or (for a new row) add it. */
export const LINE_ACTIONS = ['keep', 'replace', 'remove', 'add'] as const;

/** A typed amount as the contract's price rule reads it (Arabic digits normalized). */
const Amount = moneyInput(2).pipe(PriceString);
const Quantity = quantityInput({ min: 1, max: 10_000 });

/** A typed amount as a normalized decimal string, else null. */
function amountOf(text: string): string | null {
  const parsed = Amount.safeParse(text);
  return parsed.success ? parsed.data : null;
}

/** The ship to fields the dialog shows, as the form holds them. */
const SHIP_TO_FIELDS = ['name', 'phone', 'phoneAlt', 'address', 'courierNote'] as const;

/** The fields of the edit dialog's form (spec 0013, AC-9), before the checks. */
const EditFields = z.object({
  name: z.string().trim().max(200),
  phone: z.string().trim().max(64),
  phoneAlt: z.string().trim().max(64),
  address: z.string().trim().max(500),
  courierNote: z.string().trim().max(500),
  shippingChargedAmount: z.string(),
  reasonCode: z.string(),
  lines: z
    .array(
      z.object({
        lineId: z.string(),
        action: z.enum(LINE_ACTIONS),
        removalReason: z.string(),
        sku: Sku.nullable(),
        quantity: z.string(),
        unitPrice: z.string(),
        discountAmount: z.string(),
      }),
    )
    .max(150),
});

/**
 * The edit dialog's schema for one order: the ship to fields, the lines (every open line of the
 * order first, then rows a person adds), the shipping charge, and an optional reason. Typed text
 * is kept raw and checked in `superRefine` only for the rows a person acts on, so a line left
 * alone never blocks the form; a name, phone, or address the order has cannot be emptied. The body
 * sent to the api is built by `buildEditBody` and parsed by the contract's `OrderEditBody`, which
 * stays the one source of the rules.
 */
export function orderEditFormOf(order: OrderDetail) {
  return EditFields.superRefine((form, context) => {
    const issue = (path: (string | number)[], message: string) =>
      context.addIssue({ code: 'custom', path, message });
    for (const field of ['name', 'phone', 'address'] as const) {
      if (form[field] === '' && shown(order.shipTo[field]) !== '') issue([field], 'required');
    }
    if (form.reasonCode !== '' && !EditReasonCode.safeParse(form.reasonCode).success) {
      issue(['reasonCode'], 'reasonInvalid');
    }
    if (amountOf(form.shippingChargedAmount) === null) issue(['shippingChargedAmount'], 'amount');
    form.lines.forEach((line, index) => {
      if (
        line.action === 'remove' &&
        !LineRemovalReasonCode.safeParse(line.removalReason).success
      ) {
        issue(['lines', index, 'removalReason'], 'removalReason');
      }
      if (line.action === 'replace' || line.action === 'add') {
        if (line.sku === null) issue(['lines', index, 'sku'], 'sku');
        if (!Quantity.safeParse(line.quantity).success)
          issue(['lines', index, 'quantity'], 'quantity');
        if (amountOf(line.unitPrice) === null) issue(['lines', index, 'unitPrice'], 'amount');
        if (amountOf(line.discountAmount) === null)
          issue(['lines', index, 'discountAmount'], 'amount');
      }
    });
  });
}
/** The form as the inputs hold it. */
export type OrderEditInput = z.input<typeof EditFields>;
/** The form after the checks. */
export type OrderEditOutput = z.output<typeof EditFields>;
/** One line row of the form. */
export type OrderEditLineInput = OrderEditInput['lines'][number];

/** A new, empty row for a line a person adds. */
export const NEW_EDIT_LINE: OrderEditLineInput = {
  lineId: '',
  action: 'add',
  removalReason: '',
  sku: null,
  quantity: '',
  unitPrice: '',
  discountAmount: '0.00',
};

/** The lines an edit can still act on: the open ones (a cancelled or delivered line stays as it is). */
export function openLinesOf(order: OrderDetail) {
  return order.lines.filter((line) => line.lineState === 'open');
}

/** A stored ship to value as the form holds it: trimmed, empty when the order has none. */
const shown = (value: string | null): string => (value ?? '').trim();

/** The form's starting values: the order as it stands, every open line set to `keep`. */
export function editDefaultsOf(order: OrderDetail): OrderEditInput {
  return {
    name: shown(order.shipTo.name),
    phone: shown(order.shipTo.phone),
    phoneAlt: shown(order.shipTo.phoneAlt),
    address: shown(order.shipTo.address),
    courierNote: shown(order.shipTo.courierNote),
    shippingChargedAmount: order.money.shippingChargedAmount,
    reasonCode: '',
    lines: openLinesOf(order).map((line) => ({
      lineId: line.id,
      action: 'keep' as const,
      removalReason: '',
      sku:
        line.variantId && line.skuCode
          ? { id: line.variantId, code: line.skuCode, name: line.name ?? {} }
          : null,
      quantity: String(line.quantity),
      unitPrice: line.unitPrice,
      discountAmount: line.discountAmount,
    })),
  };
}

/** The discount that makes a gifted line free: its price times its quantity (spec 0013, AC-2). */
function giftDiscountOf(unitPrice: string, quantity: number): string {
  return Money.of(unitPrice).share(BigInt(quantity), 1n).toString();
}

/**
 * True when a replace names the same SKU, quantity, price, and discount as the line it replaces:
 * sending it would cancel a line and add an identical one, an edit and an audit entry (and, for a
 * Shopify order, a hold) for no change.
 */
function isUnchangedReplace(
  order: OrderDetail,
  lineId: string,
  next: { variantId: string; quantity: number; unitPrice: string; discountAmount: string },
): boolean {
  const source = order.lines.find((candidate) => candidate.id === lineId);
  return (
    source !== undefined &&
    source.variantId === next.variantId &&
    source.quantity === next.quantity &&
    Money.of(source.unitPrice).equals(Money.of(next.unitPrice)) &&
    Money.of(source.discountAmount).equals(Money.of(next.discountAmount))
  );
}

/**
 * The operations a form asks for, in the contract's shape; only what changed is sent. Ship to
 * fields that differ become one `ship_to` (an emptied second phone or courier note is `null`),
 * each line set to replace, remove, or add becomes its operation, and a shipping charge that
 * differs becomes `shipping`. `lines` and `shipping` are left out when the person may not change
 * them (a gifted order without `orders.gift`), and a gifted order's line discount is its full
 * price and its shipping is never sent.
 */
export function buildEditBody(
  order: OrderDetail,
  values: OrderEditOutput,
  options: { gifted: boolean; mayChangeLines: boolean },
): OrderEditBody {
  const operations: OrderEditOperation[] = [];
  const original: Record<(typeof SHIP_TO_FIELDS)[number], string> = {
    name: shown(order.shipTo.name),
    phone: shown(order.shipTo.phone),
    phoneAlt: shown(order.shipTo.phoneAlt),
    address: shown(order.shipTo.address),
    courierNote: shown(order.shipTo.courierNote),
  };
  const shipTo: Record<string, string | null> = {};
  for (const field of SHIP_TO_FIELDS) {
    if (values[field] === original[field]) continue;
    shipTo[field] =
      values[field] === '' && (field === 'phoneAlt' || field === 'courierNote')
        ? null
        : values[field];
  }
  if (Object.keys(shipTo).length > 0) {
    operations.push({ kind: 'ship_to', ...shipTo });
  }

  if (options.mayChangeLines) {
    for (const line of values.lines) {
      if (line.action === 'remove') {
        operations.push({
          kind: 'remove_line',
          lineId: line.lineId,
          cancelReasonCode: LineRemovalReasonCode.parse(line.removalReason),
        });
      } else if (line.action === 'replace' || line.action === 'add') {
        const quantity = Quantity.parse(line.quantity);
        const unitPrice = Amount.parse(line.unitPrice);
        const discountAmount = options.gifted
          ? giftDiscountOf(unitPrice, quantity)
          : Amount.parse(line.discountAmount);
        const fields = { variantId: line.sku?.id ?? '', quantity, unitPrice, discountAmount };
        if (line.action === 'replace' && isUnchangedReplace(order, line.lineId, fields)) continue;
        operations.push(
          line.action === 'replace'
            ? { kind: 'replace_line', lineId: line.lineId, ...fields }
            : { kind: 'add_line', ...fields },
        );
      }
    }
    const shipping = amountOf(values.shippingChargedAmount);
    if (
      !options.gifted &&
      shipping !== null &&
      !Money.of(shipping).equals(Money.of(order.money.shippingChargedAmount))
    ) {
      operations.push({ kind: 'shipping', shippingChargedAmount: shipping });
    }
  }

  return {
    expectedUpdatedAt: order.updatedAt,
    ...(values.reasonCode !== '' && { reasonCode: EditReasonCode.parse(values.reasonCode) }),
    operations,
  };
}
