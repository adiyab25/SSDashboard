import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Spec 0002, A13 (AC-29): only LocationPolicyService may name an owner type value. Everyone else
// asks it for the policy and reads attributes, so no module grows its own owner type rule.
//
// Four forms are violations in any scanned source file outside the allow list:
// 1. A quoted owner type literal, as a whole quoted token ('own', "own", or `own`, and the same
//    for the two partner names). A comparison, a SQL `= 'x'` or `IN ('x')`, a `case`, an array
//    with `.includes`, a `new Set([...]).has`, or a const alias all contain such a token.
// 2. A bare object key at the start of a line or after `{` or `,` (`{ consignment_partner: 2 }`,
//    `own?: string`), so prose such as "one's own: that" is not a key. Prettier's quoteProps
//    rewrites a quoted key to this, and it is how a `Record<LocationOwnerType, X>` table reads.
// 3. Zod enum access (`.enum.consignment_partner`, `LocationOwnerType.options`, `.extract`,
//    `.exclude`), which names a value or lists all of them without a quoted literal.
// 4. Either partner name as a bare whole word (`const { consignment_partner } = byType`). A word
//    boundary does not fire inside `is_consignment_partner`, so the party role columns stay clean.
// The table `location_owner_policies` is a fifth rule with its own allow list, so that the policy
// service really is its only reader.
// Comments are not stripped (a `/*` inside a string once hid code from a stripper), so prose must
// not quote the values.
const NAMES = 'own|consignment_partner|wholesale_customer';
const PATTERNS: RegExp[] = [
  new RegExp('([\'"`])(?:' + NAMES + ')\\1'),
  new RegExp('(?:^|[{,])\\s*(?:' + NAMES + ')\\s*\\??:'),
  new RegExp('\\.enum\\.(?:' + NAMES + ')\\b'),
  /\bLocationOwnerType\.(?:enum|options|extract|exclude)\b/,
  /\b(?:consignment_partner|wholesale_customer)\b/,
];

const POLICY_TABLE = /\blocation_owner_policies\b/;

/** The files that may name owner types, by full repo relative path (a same named file elsewhere is not exempt). */
const ALLOWED = new Set([
  'apps/api/src/inventory/locations/location-policy.service.ts',
  'apps/api/src/inventory/locations/location-policy.service.spec.ts',
  'apps/api/src/inventory/locations/owner-type-boundary.spec.ts',
  // The one definition of the values for the api and web (a z.enum of the three names).
  'packages/contracts/src/locations.ts',
  // SettlementOwnerType, a different enum (who an account settles with) that shares the partner name.
  'packages/contracts/src/settlement/settlement-enums.ts',
  // Web test fixtures of API answers: data, not rules.
  'apps/web/src/inventory/locations-page.spec.tsx',
  'apps/web/src/shell/location-switcher.spec.tsx',
]);

/** Who may name the policy table: the policy service, the schema and migrations, and the tests of its grants and seeds. */
const POLICY_TABLE_ALLOWED = new Set([
  'apps/api/src/inventory/locations/location-policy.service.ts',
  'apps/api/src/inventory/locations/owner-type-boundary.spec.ts',
  'packages/db/src/schema/locations.ts',
  // The table ownership map (spec 0002, A5) lists every table with its module.
  'packages/db/src/table-ownership.ts',
  'packages/db/migrations/0001_baseline_tables.sql',
  'packages/db/migrations/0002_baseline_rules.sql',
  'packages/db/test/migrate.e2e-spec.ts',
  'packages/db/test/schema.e2e-spec.ts',
]);

const REPO_ROOT = fileURLToPath(new URL('../../../../..', import.meta.url));
const SCANNED = [
  join(REPO_ROOT, 'apps', 'api', 'src'),
  join(REPO_ROOT, 'apps', 'web', 'src'),
  join(REPO_ROOT, 'packages', 'contracts', 'src'),
  join(REPO_ROOT, 'extensions'),
];
/** Where the policy table rule looks: everything above, plus the api and db tests and the migrations. */
const POLICY_TABLE_SCANNED = [
  ...SCANNED,
  join(REPO_ROOT, 'apps', 'api', 'test'),
  join(REPO_ROOT, 'packages', 'db', 'src'),
  join(REPO_ROOT, 'packages', 'db', 'test'),
  join(REPO_ROOT, 'packages', 'db', 'migrations'),
];

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === 'dist' || name === '.next') return [];
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|sql)$/.test(name) ? [path] : [];
  });
}

/** The repo relative path with forward slashes, as the allow list names it. */
function repoPath(path: string): string {
  return relative(REPO_ROOT, path).split(sep).join('/');
}

/** Whether the file may name owner types. */
function isAllowed(path: string): boolean {
  return ALLOWED.has(path);
}

/** The first line of the text that names an owner type in a forbidden form, or undefined when it is clean. */
function ownerTypeViolation(text: string): string | undefined {
  return text.split('\n').find((line) => PATTERNS.some((pattern) => pattern.test(line)));
}

/** The first line of the text that names the policy table, or undefined when it is clean. */
function policyTableViolation(text: string): string | undefined {
  return text.split('\n').find((line) => POLICY_TABLE.test(line));
}

describe('owner type boundary', () => {
  it('keeps every owner type value inside LocationPolicyService', () => {
    const offenders = SCANNED.flatMap(sourceFiles)
      .map(repoPath)
      .filter((path) => !isAllowed(path))
      .filter((path) => ownerTypeViolation(readFileSync(join(REPO_ROOT, path), 'utf8')));

    expect(offenders).toEqual([]);
  });

  it('keeps the policy table readable only through LocationPolicyService', () => {
    const offenders = POLICY_TABLE_SCANNED.flatMap(sourceFiles)
      .map(repoPath)
      .filter((path) => !POLICY_TABLE_ALLOWED.has(path))
      .filter((path) => policyTableViolation(readFileSync(join(REPO_ROOT, path), 'utf8')));

    expect(offenders).toEqual([]);
  });

  it('catches a planted read of the policy table outside the allow list', () => {
    expect(policyTableViolation('sql`SELECT * FROM location_owner_policies`')).toBeDefined();
    expect(policyTableViolation('sql`SELECT * FROM locations`')).toBeUndefined();
    expect(POLICY_TABLE_ALLOWED.has('apps/api/src/orders/orders.service.ts')).toBe(false);
  });

  it('exempts a file by its full path, not by its name', () => {
    expect(isAllowed('apps/api/src/inventory/locations/location-policy.service.ts')).toBe(true);
    expect(isAllowed('apps/api/src/orders/location-policy.service.ts')).toBe(false);
    expect(isAllowed('apps/web/src/inventory/prospec.tsx')).toBe(false);
    expect(isAllowed('apps/web/src/shell/location-switcher.spec.tsx')).toBe(true);
  });

  // One planted failing sample per form a future module might use. Each must be caught. The
  // object key samples are written the way Prettier leaves them (quoteProps: as-needed).
  it.each([
    ['a strict comparison', "if (location.ownerType === 'consignment_partner') pay();"],
    ['a reversed comparison', "if ('wholesale_customer' !== kind) skip();"],
    ['a case label', "switch (t) { case 'own': return 1; }"],
    ['an unquoted map key', 'const fee = { consignment_partner: 2 };'],
    ['an optional key in a type', 'type Fees = { own?: number };'],
    [
      'a Record lookup table',
      'const FEE: Record<LocationOwnerType, number> = { own: 0, consignment_partner: 2, wholesale_customer: 3 };',
    ],
    ['a destructured partner name', 'const { own, consignment_partner } = byType;'],
    ['a wrapped destructuring', 'const {\n  own,\n  consignment_partner,\n} = byType;'],
    ['Zod enum access', 'const t = LocationOwnerType.enum.consignment_partner;'],
    ['listing the Zod enum options', 'for (const t of LocationOwnerType.options) fee(t);'],
    ['extracting from the Zod enum', 'const partners = LocationOwnerType.exclude([x]);'],
    ['SQL equals', "sql`SELECT 1 FROM locations WHERE owner_type = 'consignment_partner'`"],
    ['SQL not equals', "sql`SELECT 1 FROM locations WHERE owner_type <> 'own'`"],
    [
      'SQL IN',
      "sql`SELECT 1 FROM locations WHERE owner_type IN ('consignment_partner', 'wholesale_customer')`",
    ],
    ['an array includes', "if (['consignment_partner', 'wholesale_customer'].includes(t)) skip();"],
    ['a const alias', "const PARTNER = 'consignment_partner'; if (t === PARTNER) skip();"],
    ['a Set lookup', "if (new Set(['own', 'wholesale_customer']).has(t)) skip();"],
    ['a double quoted literal', 'const t = "own";'],
    ['a template literal', 'const t = `wholesale_customer`;'],
    ['a literal after a glob string', "const glob = '**/*.ts'; const t = 'consignment_partner';"],
  ])('catches %s outside the policy service (planted failing case)', (_name, code) => {
    expect(ownerTypeViolation(code)).toBeDefined();
  });

  it.each([
    ['policy attributes', 'if (policy.handoverIsSale) sell();'],
    [
      'an owner type passed along as a variable',
      'locations.create({ ownerType: input.ownerType });',
    ],
    ['the word owner in a string', "const label = 'owner';"],
    ['prose that ends in own:', "/** Never one's own: that answers 409. */"],
    [
      'the party role columns',
      "const col = 'is_consignment_partner'; const w = is_wholesale_customer;",
    ],
    ['an unrelated key', 'const flags = { owned: true, ownership: 1 };'],
  ])('lets %s through', (_name, code) => {
    expect(ownerTypeViolation(code)).toBeUndefined();
  });
});
