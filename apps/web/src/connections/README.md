# Connections screens

The list of connected outside accounts at `/connections` and the Shopify connect form at `/connections/new`, for managers (`settings.manage`). Only these two screens exist so far; the detail page, its tabs, and every action beyond connect are spec 0015 milestone 4.

## Owns

- The list: [connections-page.tsx](connections-page.tsx) (the no access and error states, the empty state, Load more) and [connection-list-table.tsx](connection-list-table.tsx) (name, store code, provider, status, health with its reason and warnings in plain sentences)
- The connect form: [connect-store-form-page.tsx](connect-store-form-page.tsx) (the no access state) and [connect-store-form.tsx](connect-store-form.tsx) (validated with the contract's `ConnectShopifyBody`, each 409 and 422 code in words, the AC-1 failing reasons explained under the form)
- Calls to the api: [connections-api.ts](connections-api.ts) (`GET /api/connections`, `POST /api/connections/shopify`)
- The routes: `src/app/(backoffice)/connections/page.tsx` and `src/app/(backoffice)/connections/new/page.tsx`; the sidebar entry `connections` in `src/shell/nav.ts`

## Never touches

- A secret. The list carries none, and the form's client secret is a password input with autocomplete off, cleared as soon as the form is sent, and never kept in client state, a query cache, a toast, or a log (spec 0015, AC-2, Q-13.8).
- Whether a connection is healthy. The api and its worker decide health and its reason; the screen only words the codes (`connections.reasons.*`, `connections.warnings.*`).
- Hard coded text. Use `t()`.

## How to test

```bash
pnpm --filter @ssdashboard/web test -- src/connections
pnpm --filter @ssdashboard/web test:e2e -- e2e/connections.spec.ts --project=desktop --project=mobile
```

## Governing spec

- [0015 Shopify connector](../../../../docs/specs/0015-shopify-connector/index.md) (AC-1, AC-2, AC-27, _Connection screen and freshness line_)

## Decisions

- The form sends the schema's parsed body, so the shop domain goes out trimmed and lower cased and nothing else is rewritten; the store code is not upper cased for the person, the hint says capital letters.
- The secret field is emptied before the answer arrives, so a refused connect makes the owner type it again rather than keep it in the page.
- The form validates on submit and then on change, never on blur: an error line that appears on blur moves the Connect button between press and release and loses the click.
- The form does not use `useMutation`: a mutation keeps its variables, and so the secret, in the query client until it is reset.
