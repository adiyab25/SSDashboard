import { isDeepStrictEqual } from 'node:util';
import { redact } from '@ssdashboard/config/redaction';

/** A diff object with its personal values masked, and where they were. */
export interface MaskedDiff {
  /** The input with every personal value replaced, as `redact` does for logs. */
  masked: Record<string, unknown>;
  /** The dotted paths (array items by index) whose values were masked. */
  personalPaths: string[];
}

/**
 * Masks the personal values of a `before` or `after` object with the shared redaction list
 * (`PERSONAL_DATA_KEYS`, `PERSONAL_DATA_PATHS`, the contact and row markers, and phone shaped
 * text), and lists the paths it changed (spec 0010, AC-4). Pure: never mutates its input, never
 * logs, and never returns a personal value.
 */
export function maskPersonalData(value: Record<string, unknown>): MaskedDiff {
  const masked = redact(value) as Record<string, unknown>;
  const personalPaths: string[] = [];
  collectChangedPaths(value, masked, [], personalPaths);
  return { masked, personalPaths };
}

/**
 * Whether a value holds no personal data: its redacted copy equals it (spec 0010, "Who acts").
 * Used for `record_label` and `undo_args`, which are refused, never masked.
 */
export function holdsNoPersonalData(value: unknown): boolean {
  return isDeepStrictEqual(redact(value), value);
}

/** Adds every path where `output` differs from `input`, stopping at the first difference. */
function collectChangedPaths(
  input: unknown,
  output: unknown,
  path: readonly string[],
  found: string[],
): void {
  if (Array.isArray(input) && Array.isArray(output)) {
    input.forEach((item, index) =>
      collectChangedPaths(item, output[index], [...path, String(index)], found),
    );
    return;
  }
  if (isPlainObject(input) && isPlainObject(output)) {
    for (const key of Object.keys(input)) {
      collectChangedPaths(input[key], output[key], [...path, key], found);
    }
    return;
  }
  if (!isDeepStrictEqual(input, output)) found.push(path.join('.'));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
