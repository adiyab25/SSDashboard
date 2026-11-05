import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkExportNames,
  exportNameProblem,
  pascalCase,
  valueExports,
} from './check-component-export-names.mjs';

const SCRIPT = fileURLToPath(new URL('./check-component-export-names.mjs', import.meta.url));
const GOOD = fileURLToPath(new URL('./fixtures/export-names/good', import.meta.url));
const BAD = fileURLToPath(new URL('./fixtures/export-names/bad', import.meta.url));

describe('pascalCase', () => {
  it('turns a kebab case file name into the component name', () => {
    assert.equal(pascalCase('exchange-request-form'), 'ExchangeRequestForm');
  });
});

describe('valueExports', () => {
  it('lists values and skips types', () => {
    const { names } = valueExports(
      'export interface A {}\nexport type B = 1;\nexport const C = 1;\nexport { D, type E };\nexport default F;',
    );

    assert.deepEqual(names, ['C', 'D', 'F']);
  });

  it('flags an anonymous default export', () => {
    assert.equal(valueExports('export default function () {}').anonymousDefault, true);
  });
});

describe('exportNameProblem', () => {
  it('accepts a named or default export matching the file', () => {
    assert.equal(exportNameProblem('a-b.tsx', 'export function AB() {}'), null);
    assert.equal(exportNameProblem('a-b.tsx', 'export function AB() {}'), null);
    assert.equal(exportNameProblem('card-list.tsx', 'export default function CardList() {}'), null);
  });

  it('accepts a compound component file', () => {
    assert.equal(
      exportNameProblem('card.tsx', 'export function Card() {}\nexport function CardHeader() {}'),
      null,
    );
  });

  it('rejects a mismatch and an anonymous default', () => {
    assert.match(exportNameProblem('card.tsx', 'export function Panel() {}'), /named Card/);
    assert.match(exportNameProblem('card.tsx', 'export default () => null;'), /anonymous/);
  });

  it('skips Next special files, specs, and files with no component', () => {
    assert.equal(exportNameProblem('page.tsx', 'export default function Home() {}'), null);
    assert.equal(exportNameProblem('card.spec.tsx', 'export function Other() {}'), null);
    assert.equal(exportNameProblem('use-thing.tsx', 'export function useThing() {}'), null);
    assert.equal(exportNameProblem('constants.tsx', 'export const API_URL = "x";'), null);
  });
});

describe('checkExportNames', () => {
  it('names the file whose component does not match', () => {
    const found = checkExportNames(BAD);

    assert.equal(found.length, 2);
    assert.ok(found.some(({ path }) => /exchange-request-form\.tsx$/.test(path)));
  });

  it('exempts packages/ui/src/components only, not the same file elsewhere', () => {
    const outside = checkExportNames(BAD).filter(({ path }) => /dialog\.tsx$/.test(path));

    assert.equal(outside.length, 1);
    assert.match(
      outside[0].path.replaceAll('\\', '/'),
      /packages\/ui\/src\/exchanges\/dialog\.tsx$/,
    );
    assert.deepEqual(checkExportNames(GOOD), []);
  });

  it('passes a good tree', () => {
    assert.deepEqual(checkExportNames(GOOD), []);
  });
});

describe('the command', () => {
  it('fails on a mismatch', () => {
    const result = spawnSync(process.execPath, [SCRIPT, BAD], { encoding: 'utf8' });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /ExchangeRequestForm/);
  });

  it('passes a good tree', () => {
    const result = spawnSync(process.execPath, [SCRIPT, GOOD], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
  });
});
