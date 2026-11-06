import { MeResponse } from '@ssdashboard/contracts';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { changePasswordUrl, safeReturnTo, signInUrl } from './return-to';

const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? 'http://localhost:3001';

/**
 * Checks the session before any page inside the shell renders (spec 0005, AC-7). It asks the
 * api for `GET /api/me` with the person's cookie forwarded, so the same guard that protects
 * `/api` decides, including the 7 day cap. No session sends the person to sign in with the
 * page they asked for in `returnTo`. The answer is parsed with the `MeResponse` contract; an
 * answer that breaks it is an error, like any other answer the gate cannot read. Page content
 * and business data are never read here.
 */
export async function SessionGate({ children }: { children: React.ReactNode }) {
  const incoming = await headers();
  const response = await fetch(`${API_INTERNAL_URL}/api/me`, {
    headers: { cookie: incoming.get('cookie') ?? '' },
    cache: 'no-store',
  });

  if (response.status === 401) {
    // `x-pathname` comes from `proxy.ts`: a layout cannot read the path itself.
    redirect(signInUrl(safeReturnTo(incoming.get('x-pathname'))));
  }
  if (!response.ok) throw new Error(`The api answered ${response.status} to the session check`);

  // A temporary password must be changed before anything else (AC-14); the api refuses every
  // other route until then, so the pages would only show errors.
  const parsed = MeResponse.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error('The api answered the session check with an unknown shape');
  if (parsed.data.mustChangePassword) {
    redirect(changePasswordUrl(safeReturnTo(incoming.get('x-pathname'))));
  }
  return children;
}
