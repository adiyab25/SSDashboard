import { base } from '@ssdashboard/config/eslint/base';

// Spec 0002: only the inventory module writes the stock ledger. Other modules call its
// exported services; reaching for its Drizzle tables fails lint (and a unit test).
const LEDGER_TABLES =
  '^(stockMovements|movementGroups|movementSerials|stockLevels|reservations|serials)$';

export default [
  ...base(import.meta.dirname),
  {
    files: ['src/**/*.ts'],
    ignores: ['src/inventory/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: 'ExportDefaultDeclaration', message: 'Use a named export.' },
        {
          selector: `MemberExpression[object.name='schema'][property.name=/${LEDGER_TABLES}/]`,
          message: 'Only the inventory ledger service touches ledger tables. Call LedgerService.',
        },
        {
          selector: `ImportSpecifier[imported.name=/${LEDGER_TABLES}/]`,
          message: 'Only the inventory ledger service touches ledger tables. Call LedgerService.',
        },
      ],
    },
  },
];
