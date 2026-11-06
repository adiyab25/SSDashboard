# Sign in screens

The staff sign in flow in the browser: sign in, two factor, forgot and reset password, forced password change, and the session gate that protects back office pages.

## Owns

- Forms: [sign-in-form.tsx](sign-in-form.tsx), [two-factor-form.tsx](two-factor-form.tsx), [forgot-password-form.tsx](forgot-password-form.tsx), [reset-password-form.tsx](reset-password-form.tsx), [change-password-form.tsx](change-password-form.tsx)
- The minimal frame without the app shell: [auth-frame.tsx](auth-frame.tsx)
- The session check for back office pages: [session-gate.tsx](session-gate.tsx) (parses `/api/me` with the `MeResponse` contract and fails loudly on any other shape), [use-me.ts](use-me.ts) (the who am I answer, cached once per page load and per path, with `useMeState` telling a failed load from one still running)
- Calls to the api: [api-fetch.ts](api-fetch.ts), [auth-client.ts](auth-client.ts), [account-api.ts](account-api.ts) (`updateProfile` takes the audience and resolves its route through [me-path.ts](me-path.ts), never a free path)
- Return to the page the person came from, only inside their own audience (`/partner` for a partner user, `/` for staff): [return-to.ts](return-to.ts) (checks the path again after URL normalization, so dot segments can never turn it into `//other.site`; reads audience membership on the decoded, lowercased path), [finish-sign-in.ts](finish-sign-in.ts) (asks `/api/me`, then `/api/partner/me` on 403 `WRONG_AUDIENCE` and from then on lands on the partner home even if that call fails, applies the saved language, picks the landing page, and sends a person with a temporary password to change it first with the landing as `returnTo`)
- Routes: `/sign-in`, `/two-factor`, `/forgot-password`, `/reset-password`, `/change-password` under `src/app/(auth)`

## Never touches

- Passwords or session tokens beyond sending them to the api. Cookies are set by the api only.
- The app shell. These screens use their own frame.
- Anything that reveals whether an account exists. Show the api's answer as is.

## How to test

```bash
pnpm --filter @ssdashboard/web test -- src/auth
pnpm --filter @ssdashboard/web test:e2e -- e2e/sign-in.spec.ts
```

Other Playwright specs: `e2e/auth-flows.spec.ts`, `e2e/auth-accessibility.spec.ts`, `e2e/audience-landing.spec.ts`.

## Governing spec

- [0005 Staff sign in](../../../../docs/specs/0005-staff-sign-in/index.md)
- [0004 Localization](../../../../docs/specs/0004-localization/index.md)

## Decisions

None yet. Record non obvious decisions as ADRs in docs/adr/ and link them here.
