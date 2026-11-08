/**
 * Wraps a code (an api key, a kind, an area) in Unicode left to right isolates, so it keeps its
 * own direction when it sits inside a right to left sentence built as one string. In JSX use
 * `LtrText` from `@ssdashboard/ui` instead.
 */
export function isolateLtr(code: string): string {
  return `\u2066${code}\u2069`;
}
