import {
  EgyptianPhone,
  InvalidPhone,
  Money,
  type FulfillmentState,
  type NormalizedPhone,
  type OrderAreaCodes,
  type OrderLineState,
  type OrderType,
} from '@ssdashboard/contracts';
import type { JsonObject } from '../../audit/audit.service.js';
import {
  EditChangesPayment,
  EditOverpaid,
  GiftMustStayFree,
  InvalidOrderInput,
  InvalidPhoneAlt,
  InvalidPhoneMain,
  LineFullyDiscounted,
  OrderLocked,
  OrderNeedsALine,
  VariantUnknown,
} from '../orders.errors.js';
import { priceLines, totalsOf, type OrderTotals, type PricedLine } from '../writer/order-money.js';
import type { OrderColumnChanges } from '../writer/order-writer.js';

/** The fulfillment states an order may be edited in (spec 0013 AC-8: until the parcel leaves). */
export const EDITABLE_STATES: readonly FulfillmentState[] = ['new', 'confirmed', 'packed'];

/** The cancel reason of a line a replace takes out (AC-9): a line is never changed in place. */
export const EDIT_REMOVAL = 'edit_removal';

/** One stored line of the order being edited, with its stored figures. */
export interface PlanLine {
  id: string;
  position: number;
  variantId: string | null;
  quantity: number;
  unitPrice: string;
  discountAmount: string;
  netAmount: string;
  taxRate: string;
  taxAmount: string;
  grossAmount: string;
  lineState: OrderLineState;
  channelLineId: string | null;
  /** The line's stored share of the prepayment (the plan recomputes every share). */
  prepaidAmount: string;
  /** The line's stored share of the credit applied. */
  creditAppliedAmount: string;
}

/** The stored ship to fields, as the order holds them (phones in E.164). */
export interface PlanShipTo {
  name: string | null;
  phone: string | null;
  phoneAlt: string | null;
  contactPhoneRaw: string | null;
  address: string | null;
  courierNote: string | null;
  area: OrderAreaCodes | null;
}

/** What the plan needs of the order: read under its row lock by the caller. */
export interface PlanOrder {
  type: OrderType;
  fulfillmentState: FulfillmentState;
  carrierDeliveryCreated: boolean;
  shippingChargedAmount: string;
  prepaidAmount: string;
  creditAppliedAmount: string;
  codExpectedAmount: string;
  totalAmount: string;
  shipTo: PlanShipTo;
  lines: readonly PlanLine[];
}

/**
 * The fields of a line an operation adds; a channel edit may also give its own line id, tax rate,
 * and title, and add a line whose product is not mapped yet (`variantId` null, title required).
 */
interface AddedLineFields {
  variantId: string | null;
  /** The channel's line text (a channel edit); else the catalog name of the variant. */
  title?: string;
  quantity: number;
  unitPrice: string;
  discountAmount: string;
  /** The channel's line id (a channel edit, milestone 3); null for a person's edit. */
  channelLineId?: string | null;
  /** The line's own tax rate (a channel line); else the `sales_tax_rate` setting. */
  taxRate?: string;
}

/**
 * One operation of an edit. The contract's `OrderEditOperation` is assignable to it; the optional
 * channel fields let milestone 3's `applyChannelEdit` reuse the plan with a netted snapshot.
 */
export type PlanOperation =
  | {
      kind: 'ship_to';
      name?: string;
      phone?: string;
      phoneAlt?: string | null;
      address?: string;
      courierNote?: string | null;
      area?: OrderAreaCodes | null;
    }
  | ({ kind: 'add_line' } & AddedLineFields)
  | ({ kind: 'replace_line'; lineId: string } & AddedLineFields)
  | { kind: 'remove_line'; lineId: string; cancelReasonCode: string }
  | { kind: 'shipping'; shippingChargedAmount: string };

/** What the plan reads besides the order: the tax settings, the variants' titles, the gift right. */
export interface EditContext {
  /** The `sales_tax_rate` setting: new lines without their own rate, and the shipping tax. */
  taxRate: string;
  pricesIncludeVat: boolean;
  /** The title of every known, not archived variant an operation names; a missing one is unknown. */
  titles: ReadonlyMap<string, string>;
  /** True when a sale line may have nothing to pay (a person holding `orders.gift`, or a channel). */
  allowZeroNetLines: boolean;
  /**
   * What a new main phone that does not parse does (review R3): `refuse` for a person's edit
   * (`InvalidPhoneMain`, the edit exists to fix the phone), `keep_raw` for a channel edit
   * (milestone 3): the order keeps the text in `contact_phone_raw`, its parsed phone becomes null,
   * and the plan says `phoneUnparseable` so the caller raises `phone_unparseable`, as on creation.
   */
  unparseablePhone: 'refuse' | 'keep_raw';
  /**
   * What a second phone that does not parse does (review N4): `refuse` for a person's edit
   * (`InvalidPhoneAlt`), `drop` for a channel edit (milestone 3): the second phone is stored as
   * null and the plan says `phoneAltUnparseable` so the caller raises `phone_unparseable`. Its
   * text is kept nowhere: `contact_phone_raw` holds only a main phone that does not parse.
   */
  unparseablePhoneAlt: 'refuse' | 'drop';
}

/** The ship to columns an edit may write, by `orders` column meaning. */
export interface ShipToColumns {
  shipToName?: string;
  shipToPhone?: string | null;
  contactPhoneRaw?: string | null;
  shipToPhoneAlt?: string | null;
  shipToAddress?: string;
  courierNote?: string | null;
  shipToAreaList?: string | null;
  shipToGovernorateCode?: string | null;
  shipToCityCode?: string | null;
  shipToZoneCode?: string | null;
}

/** The names of the ship to fields an edit changed (the request's names, never their values). */
export type ShipToField = 'name' | 'phone' | 'phoneAlt' | 'address' | 'courierNote' | 'area';

/** A line the edit adds, priced, with its allocation shares. */
export interface PlannedLine extends PricedLine {
  /** Null for a channel line whose product is not mapped yet. */
  variantId: string | null;
  title: string;
  channelLineId: string | null;
  prepaidAmount: string;
  creditAppliedAmount: string;
}

/** A line's prepaid and credit shares after the edit. */
export interface LineShareChange {
  prepaidAmount: string;
  creditAppliedAmount: string;
}

/** What an edit changes, computed before anything is written. */
export interface PlannedEdit {
  /** False when every operation names the value already stored: nothing is written. */
  changed: boolean;
  cancelLines: { lineId: string; cancelReasonCode: string }[];
  addLines: PlannedLine[];
  /** The shares of every stored line after the edit (cancelled ones at 0), by line id. */
  lineShares: Map<string, LineShareChange>;
  shipToColumns: ShipToColumns;
  changedShipToFields: ShipToField[];
  /** The new main phone when it changed: the caller relinks the customer through it. */
  phone: NormalizedPhone | null;
  /** True when a channel edit set a main phone that does not parse (`keep_raw`). */
  phoneUnparseable: boolean;
  /** True when a channel edit dropped a second phone that does not parse (`drop`). */
  phoneAltUnparseable: boolean;
  shippingChargedAmount: string;
  shippingChanged: boolean;
  /** True when lines or shipping changed, so the money moved. */
  moneyChanged: boolean;
  totals: OrderTotals;
  /** True for an edit of a `packed` order, which goes back to `confirmed` (one event). */
  backToConfirmed: boolean;
  fulfillmentAfter: FulfillmentState;
}

/** A line as the plan works on it: stored or added, in position order. */
interface WorkingLine extends PricedLine {
  id: string | null;
  variantId: string | null;
  title: string | null;
  channelLineId: string | null;
}

const NOT_AN_OPEN_LINE = 'A line to change is not an open line of this order';

/**
 * Turns the operations of an edit into a planned change (spec 0013 AC-2, AC-8, AC-9): lines to
 * cancel and to add, ship to columns, shipping, and every figure recomputed with the contract
 * functions (`totalsOf`). Pure: it reads no database and no clock, and knows no person or route,
 * so a person's edit and milestone 3's channel edit share it. A line is never changed in place: a
 * replace cancels the old line with `edit_removal` and adds a new one at the next position.
 *
 * Refuses, in this order: `OrderLocked` once the carrier delivery exists or the order left `new`,
 * `confirmed`, and `packed` (the freeze); `InvalidOrderInput` for a line that is not an open line
 * of the order; `VariantUnknown`; `InvalidPhoneMain` and `InvalidPhoneAlt` (never echoing the
 * text); `OrderNeedsALine`; `GiftMustStayFree` (a gifted order's line or shipping above 0);
 * `LineFullyDiscounted` (a sale line with nothing to pay without `allowZeroNetLines`);
 * `EditOverpaid` (the total below prepaid plus credit); `EditChangesPayment` (`cod_expected_amount`
 * moving between 0 and above 0). It never changes `prepaid_amount` or `credit_applied_amount`.
 */
export function planEdit(
  order: PlanOrder,
  operations: readonly PlanOperation[],
  context: EditContext,
): PlannedEdit {
  if (order.carrierDeliveryCreated || !EDITABLE_STATES.includes(order.fulfillmentState)) {
    throw new OrderLocked();
  }
  const lines: WorkingLine[] = order.lines.map((line) => ({
    ...line,
    title: null,
  }));
  let nextPosition = Math.max(0, ...order.lines.map((line) => line.position)) + 1;
  const cancelLines: PlannedEdit['cancelLines'] = [];
  const shipToColumns: ShipToColumns = {};
  const changedShipToFields = new Set<ShipToField>();
  let phone: NormalizedPhone | null = null;
  let phoneUnparseable = false;
  let phoneAltUnparseable = false;
  let shippingChargedAmount = Money.of(order.shippingChargedAmount).toString();

  const cancel = (lineId: string, cancelReasonCode: string): void => {
    const line = lines.find((candidate) => candidate.id === lineId);
    if (!line || line.lineState !== 'open') throw new InvalidOrderInput(NOT_AN_OPEN_LINE);
    line.lineState = 'cancelled';
    cancelLines.push({ lineId, cancelReasonCode });
  };
  const add = (fields: AddedLineFields): void => {
    const known = fields.variantId === null ? undefined : context.titles.get(fields.variantId);
    if (fields.variantId !== null && known === undefined && fields.title === undefined) {
      throw new VariantUnknown();
    }
    const title = fields.title ?? known;
    if (title === undefined) throw new VariantUnknown();
    const [priced] = priceLines(
      [
        {
          quantity: fields.quantity,
          unitPrice: fields.unitPrice,
          discountAmount: fields.discountAmount,
        },
      ],
      fields.taxRate ?? context.taxRate,
      context.pricesIncludeVat,
    );
    if (!priced) throw new Error('Pricing one line returned none');
    lines.push({
      ...priced,
      position: nextPosition,
      id: null,
      variantId: fields.variantId,
      title,
      channelLineId: fields.channelLineId ?? null,
    });
    nextPosition += 1;
  };

  for (const operation of operations) {
    switch (operation.kind) {
      case 'ship_to': {
        const result = applyShipTo(
          order.shipTo,
          operation,
          shipToColumns,
          changedShipToFields,
          context,
        );
        if (result.altUnparseable) phoneAltUnparseable = true;
        if (result.phone !== null) {
          phone = result.phone;
          phoneUnparseable = false;
        }
        if (result.unparseable) {
          phone = null;
          phoneUnparseable = true;
        }
        break;
      }
      case 'add_line':
        add(operation);
        break;
      case 'replace_line':
        cancel(operation.lineId, EDIT_REMOVAL);
        add(operation);
        break;
      case 'remove_line':
        cancel(operation.lineId, operation.cancelReasonCode);
        break;
      case 'shipping':
        shippingChargedAmount = Money.of(operation.shippingChargedAmount).toString();
        break;
      default: {
        const unreachable: never = operation;
        return unreachable;
      }
    }
  }

  const added = lines.filter((line) => line.id === null);
  const shippingChanged = !Money.of(shippingChargedAmount).equals(
    Money.of(order.shippingChargedAmount),
  );
  const moneyChanged = cancelLines.length > 0 || added.length > 0 || shippingChanged;
  if (!lines.some((line) => line.lineState === 'open')) throw new OrderNeedsALine();

  if (order.type === 'gifted') {
    if (
      !Money.of(shippingChargedAmount).isZero() ||
      added.some((line) => !Money.of(line.grossAmount).isZero())
    ) {
      throw new GiftMustStayFree();
    }
  } else if (
    !context.allowZeroNetLines &&
    added.some((line) => Money.of(line.netAmount).isZero())
  ) {
    throw new LineFullyDiscounted();
  }

  const paid = Money.of(order.prepaidAmount).plus(Money.of(order.creditAppliedAmount));
  const linesGross = lines
    .filter((line) => line.lineState !== 'cancelled')
    .reduce((sum, line) => sum.plus(Money.of(line.grossAmount)), Money.zero);
  if (linesGross.plus(Money.of(shippingChargedAmount)).cents < paid.cents) {
    throw new EditOverpaid();
  }

  const backToConfirmed = order.fulfillmentState === 'packed';
  const fulfillmentAfter: FulfillmentState = backToConfirmed ? 'confirmed' : order.fulfillmentState;
  const totals = totalsOf({
    lines,
    shippingChargedAmount,
    prepaidAmount: order.prepaidAmount,
    creditAppliedAmount: order.creditAppliedAmount,
    taxRate: context.taxRate,
    fulfillmentState: fulfillmentAfter,
  });
  if (Money.of(totals.codExpectedAmount).isZero() !== Money.of(order.codExpectedAmount).isZero()) {
    throw new EditChangesPayment();
  }

  const lineShares = new Map<string, LineShareChange>();
  const addLines: PlannedLine[] = [];
  lines.forEach((line, index) => {
    const share = totals.lineShares[index] ?? {
      prepaidAmount: '0.00',
      creditAppliedAmount: '0.00',
    };
    if (line.id !== null) {
      lineShares.set(line.id, share);
    } else if (line.title !== null) {
      addLines.push({
        ...line,
        variantId: line.variantId,
        title: line.title,
        channelLineId: line.channelLineId,
        prepaidAmount: share.prepaidAmount,
        creditAppliedAmount: share.creditAppliedAmount,
      });
    }
  });

  const changed = moneyChanged || changedShipToFields.size > 0;
  return {
    changed,
    cancelLines,
    addLines,
    lineShares,
    shipToColumns,
    changedShipToFields: SHIP_TO_FIELD_ORDER.filter((field) => changedShipToFields.has(field)),
    phone,
    phoneUnparseable,
    phoneAltUnparseable,
    shippingChargedAmount,
    shippingChanged,
    moneyChanged,
    totals,
    backToConfirmed: changed && backToConfirmed,
    fulfillmentAfter: changed ? fulfillmentAfter : order.fulfillmentState,
  };
}

/** The order ship to fields are reported in. */
const SHIP_TO_FIELD_ORDER: readonly ShipToField[] = [
  'name',
  'phone',
  'phoneAlt',
  'address',
  'courierNote',
  'area',
];

/**
 * Applies one `ship_to` operation to the columns to write, recording only fields whose value
 * differs from the stored one. Answers the new main phone when it changed, and whether a main
 * phone that does not parse was kept as typed (`keep_raw`).
 */
function applyShipTo(
  current: PlanShipTo,
  operation: Extract<PlanOperation, { kind: 'ship_to' }>,
  columns: ShipToColumns,
  changed: Set<ShipToField>,
  context: Pick<EditContext, 'unparseablePhone' | 'unparseablePhoneAlt'>,
): { phone: NormalizedPhone | null; unparseable: boolean; altUnparseable: boolean } {
  let phone: NormalizedPhone | null = null;
  let unparseable = false;
  let altUnparseable = false;
  if (operation.name !== undefined && operation.name !== current.name) {
    columns.shipToName = operation.name;
    changed.add('name');
  }
  if (operation.phone !== undefined) {
    const parsed = parseMain(operation.phone, context.unparseablePhone);
    if (parsed === null) {
      const raw = operation.phone.slice(0, RAW_PHONE_LIMIT);
      if (current.phone !== null || current.contactPhoneRaw !== raw) {
        columns.shipToPhone = null;
        columns.contactPhoneRaw = raw;
        changed.add('phone');
        unparseable = true;
      }
    } else if (parsed.e164 !== current.phone || current.contactPhoneRaw !== null) {
      columns.shipToPhone = parsed.e164;
      columns.contactPhoneRaw = null;
      changed.add('phone');
      phone = parsed;
    }
  }
  if (operation.phoneAlt !== undefined) {
    const text = operation.phoneAlt?.trim() ?? '';
    const alt = text === '' ? null : parseAlt(text, context.unparseablePhoneAlt);
    if (alt !== current.phoneAlt) {
      columns.shipToPhoneAlt = alt;
      changed.add('phoneAlt');
      // Said only when the drop changes the stored phone, so an echo snapshot raises nothing again.
      if (alt === null && text !== '') altUnparseable = true;
    }
  }
  if (operation.address !== undefined && operation.address !== current.address) {
    columns.shipToAddress = operation.address;
    changed.add('address');
  }
  if (operation.courierNote !== undefined) {
    const note =
      operation.courierNote === null || operation.courierNote.trim() === ''
        ? null
        : operation.courierNote;
    if (note !== current.courierNote) {
      columns.courierNote = note;
      changed.add('courierNote');
    }
  }
  if (operation.area !== undefined && !sameArea(operation.area, current.area)) {
    columns.shipToAreaList = operation.area?.list ?? null;
    columns.shipToGovernorateCode = operation.area?.governorateCode ?? null;
    columns.shipToCityCode = operation.area?.cityCode ?? null;
    columns.shipToZoneCode = operation.area?.zoneCode ?? null;
    changed.add('area');
  }
  return { phone, unparseable, altUnparseable };
}

/** Parses a second phone: refused, or null (dropped) for a channel, when it does not parse. */
function parseAlt(text: string, mode: EditContext['unparseablePhoneAlt']): string | null {
  if (mode === 'refuse') return parseOrRefuse(text, () => new InvalidPhoneAlt()).e164;
  try {
    return EgyptianPhone.parse(text).e164;
  } catch (error) {
    if (error instanceof InvalidPhone) return null;
    throw error;
  }
}

/** The longest phone text kept as typed (`orders_contact_phone_raw_length`). */
const RAW_PHONE_LIMIT = 64;

/** Parses a new main phone: refused, or null to keep it as typed, when it does not parse. */
function parseMain(
  text: string,
  unparseablePhone: EditContext['unparseablePhone'],
): NormalizedPhone | null {
  if (unparseablePhone === 'refuse') return parseOrRefuse(text, () => new InvalidPhoneMain());
  try {
    return EgyptianPhone.parse(text);
  } catch (error) {
    if (error instanceof InvalidPhone) return null;
    throw error;
  }
}

function sameArea(a: OrderAreaCodes | null, b: OrderAreaCodes | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.list === b.list &&
    a.governorateCode === b.governorateCode &&
    a.cityCode === b.cityCode &&
    a.zoneCode === b.zoneCode
  );
}

function parseOrRefuse(text: string, refusal: () => Error): NormalizedPhone {
  try {
    return EgyptianPhone.parse(text);
  } catch (error) {
    if (error instanceof InvalidPhone) throw refusal();
    throw error;
  }
}

/** The ship to columns in the `before` and `after` of `order.edited`, with their stored values. */
const SHIP_TO_AUDIT: readonly [keyof ShipToColumns, (shipTo: PlanShipTo) => string | null][] = [
  ['shipToName', (s) => s.name],
  ['shipToPhone', (s) => s.phone],
  ['contactPhoneRaw', (s) => s.contactPhoneRaw],
  ['shipToPhoneAlt', (s) => s.phoneAlt],
  ['shipToAddress', (s) => s.address],
  ['courierNote', (s) => s.courierNote],
  ['shipToAreaList', (s) => s.area?.list ?? null],
  ['shipToGovernorateCode', (s) => s.area?.governorateCode ?? null],
  ['shipToCityCode', (s) => s.area?.cityCode ?? null],
  ['shipToZoneCode', (s) => s.area?.zoneCode ?? null],
];

/**
 * The `before` and `after` of the `order.edited` audit entry (spec 0013 Audit): the changed ship
 * to columns by their `OrderDetail` names (`AuditService.record` redacts them and lists them in
 * `personal_fields`), and when the money moved `shippingChargedAmount` (if changed),
 * `totalAmount`, `codExpectedAmount`, and `lines.added` and `lines.cancelled` as
 * `{ lineId, variantId, quantity, grossAmount }`. `after.origin` says who edited. Pure;
 * `addedLineIds` are the new lines' ids in the order of `plan.addLines`.
 */
export function editAuditDiff(
  order: PlanOrder,
  plan: PlannedEdit,
  addedLineIds: readonly string[],
  origin: 'person' | 'channel',
): { before: JsonObject; after: JsonObject } {
  const before: JsonObject = {};
  const after: JsonObject = { origin };
  for (const [column, stored] of SHIP_TO_AUDIT) {
    const value = plan.shipToColumns[column];
    if (value === undefined) continue;
    const old = stored(order.shipTo);
    // A raw phone that was and stays empty is part of the phone fix, not a change of its own.
    if (old === value) continue;
    before[column] = old;
    after[column] = value;
  }
  if (!plan.moneyChanged) return { before, after };
  if (plan.shippingChanged) {
    before.shippingChargedAmount = Money.of(order.shippingChargedAmount).toString();
    after.shippingChargedAmount = plan.shippingChargedAmount;
  }
  before.totalAmount = Money.of(order.totalAmount).toString();
  before.codExpectedAmount = Money.of(order.codExpectedAmount).toString();
  after.totalAmount = plan.totals.totalAmount;
  after.codExpectedAmount = plan.totals.codExpectedAmount;
  if (plan.addLines.length > 0 || plan.cancelLines.length > 0) {
    after.lines = {
      added: plan.addLines.map((line, index) => ({
        lineId: addedLineIds[index] ?? null,
        variantId: line.variantId,
        quantity: line.quantity,
        grossAmount: line.grossAmount,
      })),
      cancelled: plan.cancelLines.map(({ lineId }) => {
        const line = order.lines.find((candidate) => candidate.id === lineId);
        return {
          lineId,
          variantId: line?.variantId ?? null,
          quantity: line?.quantity ?? 0,
          grossAmount: line?.grossAmount ?? '0.00',
        };
      }),
    };
  }
  return { before, after };
}

/**
 * The money columns a planned edit writes when its lines or shipping changed; none for a ship to
 * only edit. Shared by a person's edit and the channel edit. The outcome is derived by the writer.
 */
export function plannedMoneyColumns(plan: PlannedEdit): OrderColumnChanges {
  if (!plan.moneyChanged) return {};
  const { totals } = plan;
  return {
    linesGrossAmount: totals.linesGrossAmount,
    shippingChargedAmount: plan.shippingChargedAmount,
    shippingTaxAmount: totals.shippingTaxAmount,
    totalAmount: totals.totalAmount,
    shippingPrepaidAmount: totals.shippingPrepaidAmount,
    shippingCreditAppliedAmount: totals.shippingCreditAppliedAmount,
    codExpectedAmount: totals.codExpectedAmount,
    codDueAmount: totals.codDueAmount,
    deliveredAmount: totals.deliveredAmount,
  };
}
