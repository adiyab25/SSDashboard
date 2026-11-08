import { EgyptianPhone, InvalidPhone, type NormalizedPhone } from '@ssdashboard/contracts';
import { InvalidPhoneAlt } from '../orders.errors.js';

/** The longest phone text kept as typed (`orders_contact_phone_raw_length`). */
const RAW_PHONE_LIMIT = 64;

/** A typed ship to phone as the order stores it. */
export interface ParsedPhones {
  /** The main phone, or null when its text does not parse. */
  main: NormalizedPhone | null;
  /** The main phone as typed, kept only when it does not parse. */
  mainRaw: string | null;
  /** The second phone normalized, or null when none was given. */
  alt: string | null;
}

/**
 * Parses the typed main and second phone with `EgyptianPhone` (spec 0013 AC-1). A main phone that
 * does not parse is not an error: the order is created unlinked and keeps the text, and the
 * caller raises `phone_unparseable`. A second phone that does not parse is refused
 * (`InvalidPhoneAlt`), because dropping it would lose the courier's second number. Neither error
 * nor result echoes a phone to a log line.
 */
export function parsePhones(phone: string, phoneAlt: string | null | undefined): ParsedPhones {
  let main: NormalizedPhone | null = null;
  try {
    main = EgyptianPhone.parse(phone);
  } catch (error) {
    if (!(error instanceof InvalidPhone)) throw error;
  }
  let alt: string | null = null;
  if (phoneAlt !== null && phoneAlt !== undefined && phoneAlt.trim() !== '') {
    try {
      alt = EgyptianPhone.parse(phoneAlt).e164;
    } catch (error) {
      if (error instanceof InvalidPhone) throw new InvalidPhoneAlt();
      throw error;
    }
  }
  return { main, mainRaw: main ? null : phone.slice(0, RAW_PHONE_LIMIT), alt };
}
