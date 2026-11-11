/**
 * The address of the merge page with one or two customers (and optionally the suggestion they came
 * from) filled in. Only ids travel in the query string, never a phone or a name (spec 0014, AC-3).
 */
export function mergePageHref(firstId: string, secondId?: string, suggestionId?: string): string {
  const query = new URLSearchParams({ a: firstId });
  if (secondId) query.set('b', secondId);
  if (suggestionId) query.set('s', suggestionId);
  return `/customers/merge?${query.toString()}`;
}
