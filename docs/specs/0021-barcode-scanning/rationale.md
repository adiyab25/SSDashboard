# 0021 rationale: barcode scanning

The decision record behind [index.md](index.md). `/develop` does not need it.

## Context

The slice 1a done when asks that every returned to origin piece of the pilot week is restocked by scan. Spec 0019 built the one door for that (`POST /api/returned-parcels/:id/pieces`, with `via: 'scan'` already in its contract) and left the scan itself to this feature: resolve a code to a variant fast, send one idempotency key per scan, and work with a keyboard wedge scanner and the phone camera.

The forces that shaped the design:

- **Egyptian offices type in Arabic.** A handheld scanner acts as a keyboard and sends key positions of a US keyboard. When the computer or phone has the Arabic layout active, the same key positions produce Arabic letters, so `TEE-BLK-M` arrives as Arabic text and never matches. This is the most common reason a wedge scanner "does not work" in an Arabic speaking office.
- **Tags vary by brand.** Some brands fill Shopify's barcode field with an EAN they bought; many print their own SKU as a Code 128; some print nothing. Spec 0012 already stores barcodes (unique per tenant, each tied to a pack unit) and syncs Shopify's one barcode as the channel barcode.
- **Phones are the warehouse's computers.** The pilot warehouse may have one laptop or none. Camera scanning in the browser is native on Chrome for Android (`BarcodeDetector`) but missing on Safari for iPhone and on desktop Firefox, so a fallback decoder is needed.
- **Labels can carry personal data.** A carrier label's QR or barcode may hold a customer's phone or address; Law 151 forbids that in logs.
- **The ledger has one writer.** Spec 0011 and spec 0019 already guard stock: a scan must never become a second path into it.

## Options considered

### Option A: a search box with focus, no new parts

Point the wedge scanner at spec 0012's existing SKU search box, and add a camera button that fills it.

**Pros**: almost nothing to build; search already has an exact barcode branch.
**Cons**: the Arabic layout problem stays; search is built for typing (union of three branches, paging), not for one exact answer under a second; nothing ties a scan to one idempotency key, so the returns flow would have to invent it; no sounds, no damaged mode, no protection against a camera reading one tag ten times.

### Option B: one scan box component and a small resolve call (chosen)

A `ScanBox` that reads wedge input by physical key and opens the camera (native detector, else a self hosted WebAssembly polyfill), one catalog route that answers exactly one code, and two consumers: spec 0019's receive call and the existing stock forms.

**Pros**: solves the layout problem at the root; one component for every later scanning job; the stock path is untouched; the server answer is a single unique index lookup.
**Cons**: a WebAssembly decoder and a build step to copy it; the browser half of the speed criterion is measured on a real phone, not in CI.

### Option C: a native or wrapped mobile app for scanning

A small Android app (or a web view wrapper) with a native scanning library.

**Pros**: the fastest and most reliable camera decoding; hardware scanner phones (with a trigger button) integrate directly.
**Cons**: a second app to build, sign, ship, and update per brand; the stack has no mobile app (spec 0007), and the pilot is weeks away; the web route groups and the audience model would need a second client.

## Rationale

Option B answers every force for the cost of one component. Reading `KeyboardEvent.code` instead of `key` fixes the Arabic layout problem with no table of Arabic letters (which would break on Shift states and on the two character `لا` key). Matching a barcode first and an exact SKU second serves both kinds of brand tag with no data entry. The resolve call belongs to the catalog, which owns barcodes; the returns screen asks spec 0019's lookup and the resolve call side by side in the browser, so no module reads another's tables and the precedence rule (parcel when no parcel is open, variant when one is) stays in one screen component.

Option A was rejected because the layout problem alone would fail the pilot. Option C is the right answer only if browser decoding proves too slow on the pilot's phones, which the milestone 2 measurement will show; nothing in Option B blocks it later, because the server side is the same.

The camera fallback is self hosted because a public CDN would see every page that opens the camera and would loosen the content security policy. The polyfill decodes in WebAssembly, which is markedly faster than a JavaScript decoder on low end Android phones.

No offline queue: a queued restock could post after another person tapped the same piece in spec 0019's view; the idempotency key protects a retry of one scan, not two doors. The Not saved list with Retry keeps every failure visible.

## Device facts this design rests on

- Handheld scanners in keyboard mode send US key positions and usually end each code with Enter; most can be set to Tab or to add a prefix. Many also send a symbology identifier (`]C1` for GS1 Code 128) when configured to, which the normalizer strips.
- `BarcodeDetector` (the Shape Detection API) is available in Chrome on Android and in Chromium on some desktops; it is not available in Safari on iPhone or in Firefox. Its formats are reported by `BarcodeDetector.getSupportedFormats()`.
- Camera access needs a secure context (HTTPS or localhost) and the page's permissions policy must allow `camera`.
- A phone's on screen keyboard (Gboard on Android, for example) sends keydown with an empty `code`, key `Unidentified`, and key code 229 for ordinary characters, so typed entries must be read from the field's input events (forum and Chromium bug evidence gathered by the domain review; the pilot phone confirms it).
- A camera stream decodes the same tag many times a second, and a tag left in the frame is read again after any time based guard; on returns, where a reread restocks a piece that never came back, one decode per tap is safer (domain review M1).
- Vibration (`navigator.vibrate`) works on Android browsers and is ignored on iPhone, so it is never the only signal.

These are general platform facts, not verified against a specific browser version in this task; milestone 2's fake camera test and the pilot phone measurement confirm them for the pilot.

## References

**Project sources**:
- [Spec 0019](../0019-delivery-failures-returned-to-origin/index.md), AC-8 to AC-10, the receive call and its `via: 'scan'`, and its Follow-up for feature 20.
- [Spec 0012](../0012-catalog-styles-variants/index.md), AC-3 and AC-10, the barcode branch of search and barcodes per pack unit.
- [Spec 0011](../0011-stock-ledger-locations/index.md), the ledger as the only writer, the adjustment and partner forms.
- `packages/config/src/redaction.ts` and the Law 151 rule of `AGENTS.md`.

**Practices and standards**:
- Idempotency keys per user action for any write that may be retried.
- WCAG 2.2 AA: status messages announced (4.1.3), information not by color alone (1.4.1), keyboard operable (2.1.1).
- Shape Detection API (`BarcodeDetector`), WICG.
