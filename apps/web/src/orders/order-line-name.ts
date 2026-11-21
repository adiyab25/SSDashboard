import type { OrderLineView } from '@ssdashboard/contracts';
import type { TextByLanguage } from '@/i18n/localized-text';

/**
 * The line's name in the reader's language from the catalog today, else the stored title (the
 * snapshot at the time of sale) when the line has no variant or the catalog lacks that language.
 * Never decides who may see the line.
 */
export function lineNameOf(line: OrderLineView, language: string): string {
  const name: TextByLanguage | null = line.name;
  return name?.[language]?.trim() || line.title;
}
