import { base } from '@ssdashboard/config/eslint/base';
import { formattingBan } from '@ssdashboard/config/eslint/i18n';

// The `Intl` formatters are built here and nowhere else (spec 0004 AC-19): only the files that
// make them are exempt, so a stray `toLocaleString` in a translator still fails.
export default [
  ...base(import.meta.dirname),
  ...formattingBan({ exempt: ['src/format.ts', 'src/plural-categories.ts'] }),
];
